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
     * @notice Check if a deposit request is allowed
     * @param sender The address of the sender of the deposit request
     * @param data The data of the deposit request
     * @return True if the deposit request is allowed, false otherwise
     */
    function canRequestDeposit(address sender, bytes calldata data) external view returns (bool);
}
