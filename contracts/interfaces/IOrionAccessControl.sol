// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @title IOrionDepositAccessControl
 * @notice Deposit access control: who may request a deposit.
 * @author Orion Finance
 */
interface IOrionDepositAccessControl is IERC165 {
    /**
     * @notice Check if a deposit request is allowed
     * @param sender The address requesting the deposit
     * @param data Additional data
     * @return True if the deposit request is allowed, false otherwise
     */
    function canRequestDeposit(address sender, bytes calldata data) external view returns (bool);
}

/**
 * @title IOrionHolderAccessControl
 * @notice Holder access control: who may hold vault shares.
 * @author Orion Finance
 */
interface IOrionHolderAccessControl is IERC165 {
    /**
     * @notice Check if an account may hold vault shares
     * @param account The prospective share holder
     * @return True if the account may hold shares, false otherwise
     */
    function canHoldShares(address account) external view returns (bool);
}

/**
 * @title IOrionTransferAccessControl
 * @notice Transfer access control: whether a P2P share transfer is allowed.
 * @author Orion Finance
 */
interface IOrionTransferAccessControl is IERC165 {
    /**
     * @notice Whether a P2P share transfer is allowed
     * @param from Share sender
     * @param to Share recipient
     * @param value Share amount
     * @param data Additional context
     * @return True if the transfer is allowed, false otherwise
     */
    function canTransferShares(
        address from,
        address to,
        uint256 value,
        bytes calldata data
    ) external view returns (bool);
}
