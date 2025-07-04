// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "./OrionVault.sol";
import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionTransparentVault.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";
import { EventsLib } from "./libraries/EventsLib.sol";

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

    /// @notice Submit a plaintext portfolio intent.
    /// @param order Position struct containing the tokens and plaintext weights.
    function submitOrderIntent(Position[] calldata order) external onlyCurator {
        if (order.length == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();

        _portfolioIntent.clear();

        uint256 totalWeight = 0;
        for (uint256 i = 0; i < order.length; i++) {
            address token = order[i].token;
            uint32 weight = order[i].weight;
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
}
