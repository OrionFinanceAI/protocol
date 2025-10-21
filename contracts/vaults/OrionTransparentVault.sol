// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "./OrionVault.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IOrionTransparentVault.sol";
import "../interfaces/IOrionStrategy.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

/**
 * @title OrionTransparentVault
 * @notice A transparent implementation of OrionVault supporting both active and passive management strategies
 * @author Orion Finance
 * @dev
 * This implementation supports two curator types:
 * 1. Active Management: Wallet curators submit intents via submitIntent() (push-based)
 * 2. Passive Management: Smart contract curators implement IOrionStrategy for on-demand intent computation (pull-based)
 *
 * The vault automatically detects curator type and handles intent retrieval accordingly.
 * Vault owners can switch between active and passive management by updating the curator.
 */
contract OrionTransparentVault is OrionVault, IOrionTransparentVault {
    using EnumerableMap for EnumerableMap.AddressToUintMap;
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice Current portfolio shares per asset (w_0) - mapping of token address to live allocation
    EnumerableMap.AddressToUintMap internal _portfolio;

    /// @notice Curator intent (w_1) - mapping of token address to target allocation
    /// @dev Only used for active management (wallet curators). Passive curators compute intents on-demand.
    EnumerableMap.AddressToUintMap internal _portfolioIntent;

    /// @notice Flag indicating if the current curator is a passive curator (smart contract)
    /// @dev This is cached to avoid repeated interface checks during intent retrieval
    bool private _isPassiveCurator;

    /// @notice Constructor
    /// @param vaultOwner The address of the vault owner
    /// @param curator The address of the vault curator
    /// @param configAddress The address of the OrionConfig contract
    /// @param name The name of the vault
    /// @param symbol The symbol of the vault
    /// @param feeType The fee type
    /// @param performanceFee The performance fee
    /// @param managementFee The management fee
    constructor(
        address vaultOwner,
        address curator,
        IOrionConfig configAddress,
        string memory name,
        string memory symbol,
        uint8 feeType,
        uint16 performanceFee,
        uint16 managementFee
    ) OrionVault(vaultOwner, curator, configAddress, name, symbol, feeType, performanceFee, managementFee) {
        _updateCuratorType(config.getAllWhitelistedAssets());
    }

    /// --------- CURATOR FUNCTIONS ---------

    /// @inheritdoc IOrionTransparentVault
    function submitIntent(Position[] calldata intent) external onlyCurator {
        if (_isPassiveCurator) revert ErrorsLib.InvalidArguments();
        if (intent.length == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();

        _portfolioIntent.clear();

        // Extract asset addresses for validation
        address[] memory assets = new address[](intent.length);

        uint256 totalWeight = 0;
        uint16 intentLength = uint16(intent.length);
        for (uint16 i = 0; i < intentLength; ++i) {
            address token = intent[i].token;
            uint32 weight = intent[i].value;
            assets[i] = token;
            bool inserted = _portfolioIntent.set(token, weight);
            if (!inserted) revert ErrorsLib.TokenAlreadyInOrder(token);
            totalWeight += weight;
        }

        // Validate that all assets in the intent are whitelisted for this vault
        _validateIntentAssets(assets);
        // Validate that the total weight is 100%
        if (totalWeight != 10 ** curatorIntentDecimals) revert ErrorsLib.InvalidTotalWeight();

        emit EventsLib.OrderSubmitted(msg.sender);
    }

    // --------- INTERNAL STATES ORCHESTRATOR FUNCTIONS ---------

    /// @inheritdoc IOrionTransparentVault
    function getPortfolio() external view returns (address[] memory tokens, uint256[] memory sharesPerAsset) {
        uint16 length = uint16(_portfolio.length());
        tokens = new address[](length);
        sharesPerAsset = new uint256[](length);
        for (uint16 i = 0; i < length; ++i) {
            (address token, uint256 sharesPerAsset_) = _portfolio.at(i);
            tokens[i] = token;
            sharesPerAsset[i] = sharesPerAsset_;
        }
    }

    /// @inheritdoc IOrionTransparentVault
    function getIntent() external view returns (address[] memory tokens, uint32[] memory weights) {
        if (_isPassiveCurator) {
            // For passive curators, compute pull intent from strategy
            return _computePassiveIntent();
        } else {
            // For active curators, return stored pushed intent
            uint16 length = uint16(_portfolioIntent.length());
            tokens = new address[](length);
            weights = new uint32[](length);
            for (uint16 i = 0; i < length; ++i) {
                (address token, uint256 weight) = _portfolioIntent.at(i);
                tokens[i] = token;
                weights[i] = uint32(weight);
            }
        }
    }

    /// @inheritdoc IOrionTransparentVault
    function updateVaultState(
        Position[] calldata portfolio,
        uint256 newTotalAssets
    ) external onlyInternalStatesOrchestrator {
        _portfolio.clear();

        uint16 portfolioLength = uint16(portfolio.length);
        for (uint16 i = 0; i < portfolioLength; ++i) {
            // slither-disable-next-line unused-return
            _portfolio.set(portfolio[i].token, portfolio[i].value);
        }

        _totalAssets = newTotalAssets;

        // Update high watermark if current price is higher
        uint256 currentSharePrice = convertToAssets(10 ** decimals());

        if (currentSharePrice > feeModel.highWaterMark) {
            feeModel.highWaterMark = currentSharePrice;
        }

        // Emit event for tracking state updates
        emit EventsLib.VaultStateUpdated(newTotalAssets);
    }

    /// --------- VAULT OWNER FUNCTIONS ---------

    /// @notice Override updateCurator to handle curator type detection
    /// @param newCurator The new curator address
    function updateCurator(address newCurator) external override(OrionVault, IOrionVault) onlyVaultOwner {
        if (newCurator == address(0)) revert ErrorsLib.InvalidAddress();
        curator = newCurator;
        _updateCuratorType(this.vaultWhitelist());
        emit CuratorUpdated(newCurator);
    }

    /// @notice Override updateVaultWhitelist to validate strategy compatibility
    /// @param assets The new whitelisted assets for the vault
    function updateVaultWhitelist(address[] calldata assets) external onlyVaultOwner {
        // Clear existing whitelist
        _vaultWhitelistedAssets.clear();

        for (uint256 i = 0; i < assets.length; ++i) {
            address token = assets[i];

            if (!config.isWhitelisted(token)) revert ErrorsLib.TokenNotWhitelisted(token);

            bool inserted = _vaultWhitelistedAssets.add(token);
            if (!inserted) revert ErrorsLib.AlreadyRegistered();
        }

        if (_isPassiveCurator) {
            IOrionStrategy(curator).validateStrategy(assets);
        }

        emit VaultWhitelistUpdated(assets);
    }

    /// --------- INTERNAL FUNCTIONS ---------

    /// @notice Update the curator type flag based on ERC-165 interface detection
    function _updateCuratorType(address[] memory whitelistedAssets) internal {
        if (curator.code.length == 0) {
            // EOA (wallet) - active curator
            _isPassiveCurator = false;
        } else {
            // Smart contract - check if it supports IOrionStrategy interface
            try IERC165(curator).supportsInterface(type(IOrionStrategy).interfaceId) returns (bool supported) {
                if (supported) {
                    _isPassiveCurator = true;
                    IOrionStrategy(curator).validateStrategy(whitelistedAssets);
                } else {
                    // Contract exists but doesn't support IOrionStrategy - invalid curator
                    revert ErrorsLib.InvalidCuratorContract();
                }
            } catch {
                // If supportsInterface fails, the curator contract is invalid
                revert ErrorsLib.InvalidCuratorContract();
            }
        }
    }

    /// @notice Compute intent for passive curators
    /// @return tokens Array of token addresses
    /// @return weights Array of weights
    function _computePassiveIntent() internal view returns (address[] memory tokens, uint32[] memory weights) {
        address[] memory whitelistedAssets = this.vaultWhitelist();
        // Call the passive curator to compute intent
        Position[] memory intent = IOrionStrategy(curator).computeIntent(whitelistedAssets);

        // Convert to return format
        tokens = new address[](intent.length);
        weights = new uint32[](intent.length);
        for (uint16 i = 0; i < intent.length; ++i) {
            tokens[i] = intent[i].token;
            weights[i] = intent[i].value;
        }
    }

    /// @notice Get the curator type
    /// @return isPassive True if the curator is passive (smart contract), false if active (wallet)
    function isPassiveCurator() external view returns (bool isPassive) {
        return _isPassiveCurator;
    }
}
