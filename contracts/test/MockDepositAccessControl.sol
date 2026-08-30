// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IOrionAccessControl } from "../interfaces/IOrionAccessControl.sol";

/**
 * @title MockDepositAccessControl
 * @notice Minimal IOrionAccessControl for kernel branch coverage tests.
 * @author Orion Finance
 */
contract MockDepositAccessControl is IOrionAccessControl {
    mapping(address => bool) public allowed;

    function setAllowed(address account, bool status) external {
        allowed[account] = status;
    }

    /// @inheritdoc IOrionAccessControl
    function canRequestDeposit(address sender, bytes calldata) external view override returns (bool) {
        return allowed[sender];
    }
}
