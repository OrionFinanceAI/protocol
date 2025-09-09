// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "./OrionVault.sol";
import "../interfaces/IOrionConfig.sol";
import "../interfaces/IOrionTransparentVault.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

/**
 * @title OrionTransparentVault
 * @notice A transparent implementation of OrionVault where curator intents are submitted in plaintext
 * @author Orion Finance
 * @dev
 * This implementation stores curator intents as a mapping of token addresses to allocation percentages.
 * The intents are submitted and readable in plaintext, making this suitable for use cases not requiring
 * privacy of the portfolio allocation strategy, while maintaining capital efficiency.
 */
contract OrionTransparentVault is OrionVault, IOrionTransparentVault {
    using EnumerableMap for EnumerableMap.AddressToUintMap;

    /// @notice Current portfolio shares per asset (w_0) - mapping of token address to live allocation
    EnumerableMap.AddressToUintMap internal _portfolio;

    /// @notice Curator intent (w_1) - mapping of token address to target allocation
    EnumerableMap.AddressToUintMap internal _portfolioIntent;

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
    ) OrionVault(vaultOwner, curator, configAddress, name, symbol, feeType, performanceFee, managementFee) {}

    /// --------- CURATOR FUNCTIONS ---------

    /// @inheritdoc IOrionTransparentVault
    function submitIntent(Position[] calldata intent) external onlyCurator {
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
        uint16 length = uint16(_portfolioIntent.length());
        tokens = new address[](length);
        weights = new uint32[](length);
        for (uint16 i = 0; i < length; ++i) {
            (address token, uint256 weight) = _portfolioIntent.at(i);
            tokens[i] = token;
            weights[i] = uint32(weight);
        }
    }

    // --------- LIQUIDITY ORCHESTRATOR FUNCTIONS ---------

    /// @inheritdoc IOrionTransparentVault
    function updateVaultState(
        Position[] calldata portfolio,
        uint256 newTotalAssets
    ) external onlyLiquidityOrchestrator {
        _portfolio.clear();

        uint16 portfolioLength = uint16(portfolio.length);
        for (uint16 i = 0; i < portfolioLength; ++i) {
            // slither-disable-next-line unused-return
            _portfolio.set(portfolio[i].token, portfolio[i].value);
        }

        _totalAssets = newTotalAssets;

        // Emit event for tracking state updates
        emit EventsLib.VaultStateUpdated(newTotalAssets);
    }
}
