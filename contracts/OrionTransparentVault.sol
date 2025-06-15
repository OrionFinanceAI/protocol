// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "./OrionVault.sol";
import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionTransparentVault.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";

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

    struct Order {
        address token;
        uint32 amount;
    }

    EnumerableMap.AddressToUintMap private _orders;

    constructor(
        address _curator,
        address _config,
        string memory _name,
        string memory _symbol
    ) OrionVault(_curator, _config, _name, _symbol) {}

    /// --------- CURATOR FUNCTIONS ---------

    /// @notice Submit a plaintext portfolio intent.
    /// @param order Order struct containing the tokens and plaintext amounts.
    function submitOrderIntent(Order[] calldata order) external onlyCurator {
        if (order.length == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();
        _orders.clear();

        uint256 totalAmount = 0;
        for (uint256 i = 0; i < order.length; i++) {
            address token = order[i].token;
            uint32 amount = order[i].amount;
            if (!config.isWhitelisted(token)) revert ErrorsLib.TokenNotWhitelisted(token);
            if (amount == 0) revert ErrorsLib.AmountMustBeGreaterThanZero(token);
            bool inserted = _orders.set(token, amount);
            if (!inserted) revert ErrorsLib.TokenAlreadyInOrder(token);
            totalAmount += amount;
        }

        uint8 curatorIntentDecimals = config.curatorIntentDecimals();
        if (totalAmount != 10 ** curatorIntentDecimals) revert ErrorsLib.InvalidTotalAmount();

        emit OrderSubmitted(msg.sender);
    }
}
