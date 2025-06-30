// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import { euint32 } from "fhevm/lib/TFHE.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "./OrionVault.sol";
import "./interfaces/IOrionConfig.sol";
import "./interfaces/IOrionEncryptedVault.sol";
import { ErrorsLib } from "./libraries/ErrorsLib.sol";
import { EventsLib } from "./libraries/EventsLib.sol";

/**
 * @title OrionEncryptedVault
 * @notice A privacy-preserving implementation of OrionVault where curator intents are submitted in encrypted form
 * @dev
 * This implementation stores curator intents as a mapping of token addresses to encrypted allocation percentages.
 * The intents are submitted and stored in encrypted form using FHEVM, making this suitable for use cases requiring
 * privacy of the portfolio allocation strategy, while maintaining capital efficiency.
 */
contract OrionEncryptedVault is OrionVault, IOrionEncryptedVault {
    using EnumerableMap for EnumerableMap.AddressToUintMap;

    EnumerableMap.AddressToUintMap private _orders;

    function initialize(
        address _curator,
        IOrionConfig _config,
        string memory _name,
        string memory _symbol
    ) public initializer {
        __OrionVault_init(_curator, _config, _name, _symbol);
    }

    /// --------- CURATOR FUNCTIONS ---------

    /// @notice Submit an encrypted portfolio intent.
    /// @param order Order struct containing the tokens and encrypted amounts.
    function submitOrderIntent(Order[] calldata order) external onlyCurator {
        if (order.length == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();
        _orders.clear();

        for (uint256 i = 0; i < order.length; i++) {
            address token = order[i].token;
            euint32 amount = order[i].amount;
            if (!config.isWhitelisted(token)) revert ErrorsLib.TokenNotWhitelisted(token);
            bool inserted = _orders.set(token, euint32.unwrap(amount));
            if (!inserted) revert ErrorsLib.TokenAlreadyInOrder(token);
        }

        emit EventsLib.OrderSubmitted(msg.sender);
    }
}
