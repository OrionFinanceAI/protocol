// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IAccessControl } from "../interfaces/IAccessControl.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
/**
 * @title WhitelistAccessControl
 * @notice Implementation of IAccessControl with whitelist-based access
 */
contract WhitelistAccessControl is IAccessControl, Ownable2Step {
    /// @notice Mapping of addresses allowed to deposit
    mapping(address => bool) public whitelist;

    /// @notice Emitted when an address is added to the whitelist
    event AddressWhitelisted(address indexed account);

    /// @notice Emitted when an address is removed from the whitelist
    event AddressRemovedFromWhitelist(address indexed account);

    constructor(address initialOwner_) Ownable(initialOwner_) {
        if (initialOwner_ == address(0)) revert ErrorsLib.ZeroAddress();
    }

    /// @inheritdoc IAccessControl
    function canRequestDeposit(address sender) external view override returns (bool) {
        return whitelist[sender];
    }

    /**
     * @notice Add addresses to the whitelist
     * @param accounts Array of addresses to whitelist
     * @dev Only callable by owner
     */
    function addToWhitelist(address[] calldata accounts) external onlyOwner {
        for (uint256 i = 0; i < accounts.length; ++i) {
            whitelist[accounts[i]] = true;
            emit AddressWhitelisted(accounts[i]);
        }
    }

    /**
     * @notice Remove addresses from the whitelist
     * @param accounts Array of addresses to remove from the whitelist
     * @dev Only callable by owner
     */
    function removeFromWhitelist(address[] calldata accounts) external onlyOwner {
        for (uint256 i = 0; i < accounts.length; ++i) {
            whitelist[accounts[i]] = false;
            emit AddressRemovedFromWhitelist(accounts[i]);
        }
    }
}
