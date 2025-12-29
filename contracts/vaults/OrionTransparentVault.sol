// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "./OrionVault.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IOrionTransparentVault.sol";
import "../interfaces/IOrionStrategist.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

/**
 * @title OrionTransparentVault
 * @notice A transparent implementation of OrionVault supporting both active and passive management strategies
 * @author Orion Finance
 * @dev
 * This implementation supports two strategist types:
 * 1. Active Management: Wallet strategists submit intents via submitIntent()
 * 2. Passive Management: Smart contract strategists implement IOrionStrategist for on-demand intent computation
 * @custom:security-contact security@orionfinance.ai
 */
contract OrionTransparentVault is OrionVault, IOrionTransparentVault {
    using EnumerableMap for EnumerableMap.AddressToUintMap;
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice Current portfolio shares per asset (w_0) - mapping of token address to live allocation
    EnumerableMap.AddressToUintMap internal _portfolio;

    /// @notice Strategist intent (w_1) - mapping of token address to target allocation
    EnumerableMap.AddressToUintMap internal _portfolioIntent;

    /// @notice Constructor that disables initializers for the implementation contract
    /// @custom:oz-upgrades-unsafe-allow constructor
    // solhint-disable-next-line use-natspec
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the vault
    /// @param manager_ The address of the vault manager
    /// @param strategist_ The address of the vault strategist
    /// @param config_ The address of the OrionConfig contract
    /// @param name_ The name of the vault
    /// @param symbol_ The symbol of the vault
    /// @param feeType_ The fee type
    /// @param performanceFee_ The performance fee
    /// @param managementFee_ The management fee
    /// @param depositAccessControl_ The address of the deposit access control contract (address(0) = permissionless)
    function initialize(
        address manager_,
        address strategist_,
        IOrionConfig config_,
        string memory name_,
        string memory symbol_,
        uint8 feeType_,
        uint16 performanceFee_,
        uint16 managementFee_,
        address depositAccessControl_
    ) public initializer {
        // Call parent initializer
        __OrionVault_init(
            manager_,
            strategist_,
            config_,
            name_,
            symbol_,
            feeType_,
            performanceFee_,
            managementFee_,
            depositAccessControl_
        );

        // slither-disable-next-line unused-return
        _portfolioIntent.set(address(config.underlyingAsset()), uint32(10 ** config.strategistIntentDecimals()));
    }

    /// --------- STRATEGIST FUNCTIONS ---------

    /// @inheritdoc IOrionTransparentVault
    function submitIntent(IntentPosition[] calldata intent) external onlyStrategist {
        if (intent.length == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();

        _portfolioIntent.clear();

        // Extract asset addresses for validation
        address[] memory assets = new address[](intent.length);

        uint256 totalWeight = 0;
        uint16 intentLength = uint16(intent.length);
        for (uint16 i = 0; i < intentLength; ++i) {
            address token = intent[i].token;
            uint32 weight = intent[i].weight;
            assets[i] = token;
            bool inserted = _portfolioIntent.set(token, weight);
            if (!inserted) revert ErrorsLib.TokenAlreadyInOrder(token);
            totalWeight += weight;
        }

        // Validate that all assets in the intent are whitelisted for this vault
        _validateIntentAssets(assets);
        // Validate that the total weight is 100%
        if (totalWeight != 10 ** config.strategistIntentDecimals()) revert ErrorsLib.InvalidTotalWeight();

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
        if (isDecommissioning) {
            tokens = new address[](1);
            weights = new uint32[](1);
            tokens[0] = address(config.underlyingAsset());
            weights[0] = uint32(10 ** config.strategistIntentDecimals()); // 100%
        } else {
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
        address[] calldata tokens,
        uint256[] calldata shares,
        uint256 newTotalAssets
    ) external onlyLiquidityOrchestrator {
        _portfolio.clear();

        uint16 portfolioLength = uint16(tokens.length);
        for (uint16 i = 0; i < portfolioLength; ++i) {
            // slither-disable-next-line unused-return
            _portfolio.set(tokens[i], shares[i]);
        }

        _totalAssets = newTotalAssets;

        uint256 currentSharePrice = convertToAssets(10 ** decimals());

        if (currentSharePrice > feeModel.highWaterMark) {
            feeModel.highWaterMark = currentSharePrice;
        }

        // Emit event for tracking state updates
        emit EventsLib.VaultStateUpdated(newTotalAssets);
    }

    /// --------- MANAGER FUNCTIONS ---------

    /// @inheritdoc IOrionVault
    function updateStrategist(address newStrategist) external onlyManager {
        strategist = newStrategist;
        emit StrategistUpdated(newStrategist);
    }

    /// @inheritdoc IOrionVault
    function updateVaultWhitelist(address[] calldata assets) external onlyManager {
        // Clear existing whitelist
        _vaultWhitelistedAssets.clear();

        for (uint256 i = 0; i < assets.length; ++i) {
            address token = assets[i];

            if (!config.isWhitelisted(token)) revert ErrorsLib.TokenNotWhitelisted(token);

            bool inserted = _vaultWhitelistedAssets.add(token);
            if (!inserted) revert ErrorsLib.AlreadyRegistered();
        }

        if (!_vaultWhitelistedAssets.contains(this.asset())) {
            // slither-disable-next-line unused-return
            _vaultWhitelistedAssets.add(this.asset());
        }

        emit VaultWhitelistUpdated(assets);
    }

    /// @notice Remove an asset from the vault whitelist and modify intent accordingly
    /// @param asset The asset to remove from the whitelist
    function removeFromVaultWhitelist(address asset) external onlyConfig {
        // slither-disable-next-line unused-return
        _vaultWhitelistedAssets.remove(asset);

        (bool exists, uint256 blacklistedWeight) = _portfolioIntent.tryGet(asset);
        if (!exists) return; // Asset not in intent, nothing to modify

        // slither-disable-next-line unused-return
        _portfolioIntent.remove(asset);

        // Add the weight to the underlying asset
        address underlyingAsset = this.asset();
        (bool underlyingExists, uint256 currentUnderlyingWeight) = _portfolioIntent.tryGet(underlyingAsset);
        if (underlyingExists) {
            // slither-disable-next-line unused-return
            _portfolioIntent.set(underlyingAsset, currentUnderlyingWeight + blacklistedWeight);
        } else {
            // slither-disable-next-line unused-return
            _portfolioIntent.set(underlyingAsset, blacklistedWeight);
        }
    }

    /// @dev Storage gap to allow for future upgrades
    uint256[50] private __gap;
}
