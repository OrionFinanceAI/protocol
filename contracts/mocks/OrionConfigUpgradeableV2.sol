// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "../OrionConfigUpgradeable.sol";

/**
 * @title OrionConfigUpgradeableV2
 * @notice Mock V2 implementation for testing UUPS upgrades
 * @author Orion Finance
 * @dev Adds a new state variable and function to demonstrate upgrade functionality
 */
contract OrionConfigUpgradeableV2 is OrionConfigUpgradeable {
    /// @notice New state variable added in V2
    uint256 public newV2Variable;

    /// @notice Event emitted when V2 variable is set
    event V2VariableSet(uint256 value);

    /// @notice New function added in V2 to demonstrate upgrade functionality
    /// @param value The value to set
    function setV2Variable(uint256 value) external onlyOwner {
        newV2Variable = value;
        emit V2VariableSet(value);
    }

    /// @notice Function to verify this is V2
    /// @return The version string
    function version() external pure returns (string memory) {
        return "v2";
    }
}
