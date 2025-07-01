// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import { euint32 } from "fhevm/lib/TFHE.sol";
import "./IOrionVault.sol";

interface IOrionEncryptedVault is IOrionVault {
    struct EncryptedPosition {
        address token;
        euint32 weight;
    }

    /// @notice Submit an encrypted portfolio intent.
    /// @param order EncryptedPosition struct containing the tokens and encrypted weights.
    function submitOrderIntent(EncryptedPosition[] calldata order) external;
}
