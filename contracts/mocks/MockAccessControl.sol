// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IAccessControl } from "../interfaces/IAccessControl.sol";

/**
 * @title MockAccessControl
 * @notice Reference implementation of IAccessControl with whitelist-based access
 * @dev This is a mock/example implementation for testing and reference purposes
 * @dev Production implementations should add appropriate access controls and events
 */
contract MockAccessControl is IAccessControl {
    /// @notice Owner of the access control contract
    address public owner;

    /// @notice Mapping of addresses allowed to deposit
    mapping(address => bool) public whitelist;

    /// @notice Emitted when an address is added to the whitelist
    event AddressWhitelisted(address indexed account);

    /// @notice Emitted when an address is removed from the whitelist
    event AddressRemovedFromWhitelist(address indexed account);

    /// @notice Emitted when ownership is transferred
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    /**
     * @notice Check if an address can request deposits
     * @param sender Address to check
     * @return True if sender is whitelisted, false otherwise
     * @dev This function NEVER reverts - returns false for non-whitelisted addresses
     */
    function canRequestDeposit(address sender) external view override returns (bool) {
        return whitelist[sender];
    }

    /**
     * @notice Add an address to the whitelist
     * @param account Address to whitelist
     * @dev Only callable by owner
     */
    function addToWhitelist(address account) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        whitelist[account] = true;
        emit AddressWhitelisted(account);
    }

    /**
     * @notice Remove an address from the whitelist
     * @param account Address to remove
     * @dev Only callable by owner
     */
    function removeFromWhitelist(address account) external onlyOwner {
        whitelist[account] = false;
        emit AddressRemovedFromWhitelist(account);
    }

    /**
     * @notice Add multiple addresses to the whitelist in one transaction
     * @param accounts Array of addresses to whitelist
     * @dev Only callable by owner
     */
    function addBatchToWhitelist(address[] calldata accounts) external onlyOwner {
        for (uint256 i = 0; i < accounts.length; ++i) {
            if (accounts[i] == address(0)) revert ZeroAddress();
            whitelist[accounts[i]] = true;
            emit AddressWhitelisted(accounts[i]);
        }
    }

    /**
     * @notice Transfer ownership of the access control contract
     * @param newOwner Address of the new owner
     * @dev Only callable by current owner
     */
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }
}
