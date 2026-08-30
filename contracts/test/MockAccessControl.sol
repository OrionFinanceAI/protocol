// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {
    IOrionDepositAccessControl,
    IOrionHolderAccessControl,
    IOrionTransferAccessControl
} from "../interfaces/IOrionAccessControl.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";

/**
 * @title MockAccessControl
 * @notice Minimal mock implementing all three investor access-control interfaces.
 * @author Orion Finance
 */
contract MockAccessControl is
    IOrionDepositAccessControl,
    IOrionHolderAccessControl,
    IOrionTransferAccessControl,
    ERC165
{
    mapping(address => bool) public depositAllowed;
    mapping(address => bool) public holderAllowed;
    mapping(address => bool) public transferAllowed;

    function setDepositAllowed(address account, bool status) external {
        depositAllowed[account] = status;
    }

    function setHolderAllowed(address account, bool status) external {
        holderAllowed[account] = status;
    }

    function setTransferAllowed(address account, bool status) external {
        transferAllowed[account] = status;
    }

    /// @inheritdoc IOrionDepositAccessControl
    function canRequestDeposit(address sender, bytes calldata) external view override returns (bool) {
        return depositAllowed[sender];
    }

    /// @inheritdoc IOrionHolderAccessControl
    function canHoldShares(address account) external view override returns (bool) {
        return holderAllowed[account];
    }

    /// @inheritdoc IOrionTransferAccessControl
    function canTransferShares(address account, bytes calldata) external view override returns (bool) {
        return transferAllowed[account];
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165, IERC165) returns (bool) {
        return
            interfaceId == type(IOrionDepositAccessControl).interfaceId ||
            interfaceId == type(IOrionHolderAccessControl).interfaceId ||
            interfaceId == type(IOrionTransferAccessControl).interfaceId ||
            super.supportsInterface(interfaceId);
    }
}
