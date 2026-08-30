// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @title IOrionAccessControl
 * @notice Interface for deposit access control in Orion vaults
 * @author Orion Finance
 * @dev Gate deposit requests with arbitrary onchain policy (e.g. compliance checks,
 *      strategy capacity limits, allowlists). Implementors must support ERC-165 so
 *      that vaults can reject non-ACL contracts.
 * @custom:security-contact security@orionfinance.ai
 */
interface IOrionAccessControl is IERC165 {
    /**
     * @notice Check if a deposit request is allowed
     * @param sender The address of the sender of the deposit request
     * @param data The data of the deposit request
     * @return True if the deposit request is allowed, false otherwise
     */
    function canRequestDeposit(address sender, bytes calldata data) external view returns (bool);
}
