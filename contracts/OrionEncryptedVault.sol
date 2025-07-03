// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import { euint32 } from "fhevm/lib/TFHE.sol";
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

    function initialize(
        address curatorAddress,
        IOrionConfig configAddress,
        string calldata name,
        string calldata symbol
    ) public initializer {
        __OrionVault_init(curatorAddress, configAddress, name, symbol);
    }

    /// --------- CURATOR FUNCTIONS ---------

    /// @notice Submit an encrypted portfolio intent.
    /// @param order EncryptedPosition struct containing the tokens and encrypted weights.
    function submitOrderIntent(EncryptedPosition[] calldata order) external onlyCurator {
        if (order.length == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();
        _orders.clear();

        for (uint256 i = 0; i < order.length; i++) {
            address token = order[i].token;
            euint32 weight = order[i].weight;
            if (!config.isWhitelisted(token)) revert ErrorsLib.TokenNotWhitelisted(token);
            bool inserted = _orders.set(token, euint32.unwrap(weight));
            if (!inserted) revert ErrorsLib.TokenAlreadyInOrder(token);
        }

        emit EventsLib.OrderSubmitted(msg.sender);
    }
}
