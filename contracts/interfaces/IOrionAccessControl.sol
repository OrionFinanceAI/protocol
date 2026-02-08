// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IOrionAccessControl
 * @notice Interface for deposit access control in Orion vaults
 * @author Orion Finance
 * @dev Used to implement KYC, AML, and other compliance requirements
 * @custom:security-contact security@orionfinance.ai
 */
interface IOrionAccessControl {
    /**
     * @notice Check if an address is allowed to request deposits to the vault
     * @param sender Address attempting to deposit
     * @return True if sender is allowed to deposit, false otherwise
     */
    function canRequestDeposit(address sender) external view returns (bool);
}
