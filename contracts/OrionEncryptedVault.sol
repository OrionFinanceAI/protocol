// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import { euint32 } from "../lib/fhevm-solidity/lib/FHE.sol";
import "./interfaces/IOrionConfig.sol";
import "./OrionVault.sol";
import "./interfaces/IOrionEncryptedVault.sol";

/**
 * @title OrionEncryptedVault
 * @notice A privacy-preserving implementation of OrionVault where curator intents are submitted in encrypted form
 * @dev
 * This implementation stores curator intents as a mapping of token addresses to encrypted allocation percentages.
 * The intents are submitted and stored in encrypted form using FHEVM, making this suitable for use cases requiring
 * privacy of the portfolio allocation strategy, while maintaining capital efficiency.
 */
contract OrionEncryptedVault is OrionVault, IOrionEncryptedVault {
    struct Order {
        address token;
        euint32 amount;
    }

    mapping(address => euint32) private _orders;

    constructor(
        address _curator,
        address _config,
        string memory _name,
        string memory _symbol
    ) OrionVault(_curator, _config, _name, _symbol) {}

    /// --------- CURATOR FUNCTIONS ---------

    /// @notice Submit an encrypted portfolio intent.
    /// @param order Order struct containing the tokens and encrypted amounts.
    function submitOrderIntent(Order[] calldata order) external onlyCurator {
        if (order.length == 0) revert ErrorsLib.OrderIntentCannotBeEmpty();

        for (uint256 i = 0; i < order.length; i++) {
            _orders[order[i].token] = euint32.wrap(0);
        }

        for (uint256 i = 0; i < order.length; i++) {
            address token = order[i].token;
            euint32 amount = order[i].amount;
            if (!config.isWhitelisted(token)) revert ErrorsLib.TokenNotWhitelisted(token);
            _orders[token] = amount;
        }

        emit OrderSubmitted(msg.sender);
    }
}
