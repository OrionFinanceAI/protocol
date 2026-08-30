// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IOrionAccessControl } from "../interfaces/IOrionAccessControl.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";

/**
 * @title MockDepositAccessControl
 * @notice Minimal IOrionAccessControl for kernel branch coverage tests.
 * @author Orion Finance
 */
contract MockDepositAccessControl is IOrionAccessControl, ERC165 {
    mapping(address => bool) public allowed;

    function setAllowed(address account, bool status) external {
        allowed[account] = status;
    }

    /// @inheritdoc IOrionAccessControl
    function canRequestDeposit(address sender, bytes calldata) external view override returns (bool) {
        return allowed[sender];
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IOrionAccessControl).interfaceId || super.supportsInterface(interfaceId);
    }
}
