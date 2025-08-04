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

    function initialize(
        address curatorAddress,
        IOrionConfig configAddress,
        string calldata name,
        string calldata symbol
    ) public initializer {
        __OrionVault_init(curatorAddress, configAddress, name, symbol);
    }

    /// --------- CURATOR FUNCTIONS ---------

    /// @inheritdoc IOrionTransparentVault
    function submitIntent(Position[] calldata order) external onlyCurator {
        if (order.length == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();

        _portfolioIntent.clear();

        uint256 totalWeight = 0;
        uint256 orderLength = order.length;
        for (uint256 i = 0; i < orderLength; i++) {
            address token = order[i].token;
            uint32 weight = order[i].value;
            if (!config.isWhitelisted(token)) revert ErrorsLib.TokenNotWhitelisted(token);
            if (weight == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(token);
            bool inserted = _portfolioIntent.set(token, weight);
            if (!inserted) revert ErrorsLib.TokenAlreadyInOrder(token);
            totalWeight += weight;
        }

        uint8 curatorIntentDecimals = config.curatorIntentDecimals();
        if (totalWeight != 10 ** curatorIntentDecimals) revert ErrorsLib.InvalidTotalWeight();

        emit EventsLib.OrderSubmitted(msg.sender);
    }

    // --------- INTERNAL STATES ORCHESTRATOR FUNCTIONS ---------

    /// @inheritdoc IOrionTransparentVault
    function getPortfolio() external view returns (address[] memory tokens, uint256[] memory sharesPerAsset) {
        uint256 length = _portfolio.length();
        tokens = new address[](length);
        sharesPerAsset = new uint256[](length);
        for (uint256 i = 0; i < length; i++) {
            (address token, uint256 sharesPerAsset_) = _portfolio.at(i);
            tokens[i] = token;
            sharesPerAsset[i] = sharesPerAsset_;
        }
    }

    /// @inheritdoc IOrionTransparentVault
    function getIntent() external view returns (address[] memory tokens, uint256[] memory weights) {
        uint256 length = _portfolioIntent.length();
        tokens = new address[](length);
        weights = new uint256[](length);
        for (uint256 i = 0; i < length; i++) {
            (address token, uint256 weight) = _portfolioIntent.at(i);
            tokens[i] = token;
            weights[i] = weight;
        }
    }

    // --------- LIQUIDITY ORCHESTRATOR FUNCTIONS ---------

    /// @inheritdoc IOrionTransparentVault
    function updateVaultState(
        Position[] calldata portfolio,
        uint256 newTotalAssets
    ) external onlyLiquidityOrchestrator {
        _portfolio.clear();

        uint256 portfolioLength = portfolio.length;
        for (uint256 i = 0; i < portfolioLength; i++) {
            // slither-disable-next-line unused-return
            _portfolio.set(portfolio[i].token, portfolio[i].value);
        }

        _totalAssets = newTotalAssets;

        // Emit event for tracking state updates
        emit EventsLib.VaultStateUpdated(newTotalAssets);
    }
}
