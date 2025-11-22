// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IAccessControl
 * @notice Interface for deposit access control in Orion vaults
 * @author Orion Finance
 * @dev Used to implement KYC, whitelisting, or other compliance requirements
 */
interface IAccessControl {
    /**
     * @notice Check if an address is allowed to request deposits to the vault
     * @param sender Address attempting to deposit
     * @return True if sender is allowed to deposit, false otherwise
     */
    function canRequestDeposit(address sender) external view returns (bool);
}
