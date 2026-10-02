// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {
    IOrionDepositAccessControl,
    IOrionHolderAccessControl,
    IOrionTransferAccessControl
} from "../interfaces/IOrionAccessControl.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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
    function canTransferShares(
        address from,
        address,
        uint256,
        bytes calldata
    ) external view override returns (bool) {
        return transferAllowed[from];
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

/**
 * @title MockRecordingTransferAccessControl
 * @notice View-safe transfer ACL for tests: optional exact `(from, to, amount)` match and/or max amount.
 */
contract MockRecordingTransferAccessControl is IOrionTransferAccessControl, ERC165 {
    bool public defaultAllow = true;
    bool public checkExact;
    address public expectedFrom;
    address public expectedTo;
    uint256 public expectedAmount;
    uint256 public maxAmount; // 0 = no amount cap

    function setDefaultAllow(bool allow) external {
        defaultAllow = allow;
    }

    function setMaxAmount(uint256 maxAmount_) external {
        maxAmount = maxAmount_;
    }

    function expectTransfer(address from, address to, uint256 value) external {
        expectedFrom = from;
        expectedTo = to;
        expectedAmount = value;
        checkExact = true;
    }

    function clearExpect() external {
        checkExact = false;
    }

    /// @inheritdoc IOrionTransferAccessControl
    function canTransferShares(
        address from,
        address to,
        uint256 value,
        bytes calldata
    ) external view override returns (bool) {
        if (maxAmount != 0 && value > maxAmount) return false;
        if (checkExact) {
            return from == expectedFrom && to == expectedTo && value == expectedAmount;
        }
        return defaultAllow;
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(IOrionTransferAccessControl).interfaceId || super.supportsInterface(interfaceId);
    }
}

/**
 * @title OpaqueVaultTransferHelper
 * @notice Moves shares via `transferFrom` under a non-`transfer` outer selector.
 */
contract OpaqueVaultTransferHelper {
    function moveShares(address vault, address from, address to, uint256 amount) external {
        IERC20(vault).transferFrom(from, to, amount);
    }
}
