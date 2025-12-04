// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../vaults/OrionTransparentVaultUpgradeable.sol";

/**
 * @title OrionTransparentVaultUpgradeableV2
 * @notice Mock V2 implementation for testing Beacon Proxy upgrades
 * @author Orion Finance
 * @dev Adds a new state variable and function to demonstrate beacon upgrade functionality
 */
contract OrionTransparentVaultUpgradeableV2 is OrionTransparentVaultUpgradeable {
    /// @notice New state variable added in V2
    string public vaultDescription;

    /// @notice Event emitted when vault description is set
    event VaultDescriptionSet(string description);

    /// @notice New function added in V2 to demonstrate upgrade functionality
    /// @param description The description to set
    function setVaultDescription(string memory description) external onlyVaultOwner {
        vaultDescription = description;
        emit VaultDescriptionSet(description);
    }

    /// @notice Function to verify this is V2
    /// @return The version string
    function version() external pure returns (string memory) {
        return "v2";
    }
}
