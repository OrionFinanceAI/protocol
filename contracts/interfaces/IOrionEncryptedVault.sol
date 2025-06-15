// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import { euint32 } from "fhevm/lib/TFHE.sol";
import "./IOrionVault.sol";

interface IOrionEncryptedVault is IOrionVault {
    struct Order {
        address token;
        euint32 amount;
    }

    /// @notice Submit an encrypted portfolio intent.
    /// @param order Order struct containing the tokens and encrypted amounts.
    function submitOrderIntent(Order[] calldata order) external;
}
