// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "./IOrionVault.sol";

interface IOrionTransparentVault is IOrionVault {
    struct Order {
        address token;
        uint32 amount;
    }

    /// @notice Submit a plaintext portfolio intent.
    /// @param order Order struct containing the tokens and plaintext amounts.
    function submitOrderIntent(Order[] calldata order) external;
}
