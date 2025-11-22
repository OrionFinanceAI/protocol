// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IAccessControl
 * @notice Interface for deposit access control in Orion vaults
 * @dev Access control contracts MUST return bool
 * @dev Used to implement KYC, whitelisting, or other compliance requirements
 */
interface IAccessControl {
    /**
     * @notice Check if an address is allowed to request deposits to the vault
     * @param sender Address attempting to deposit
     * @return True if sender is allowed to deposit, false otherwise
     * @dev CRITICAL: This function MUST NOT revert under any circumstances
     * @dev CRITICAL: This function MUST be a view function (no state changes)
     * @dev CRITICAL: This function MUST NOT consume excessive gas (recommended < 100k gas)
     * @dev Returning false will prevent the sender from depositing
     * @dev Example use cases: KYC verification, whitelist checks, deposit caps per user
     */
    function canRequestDeposit(address sender) external view returns (bool);
}
