// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

/// @title IAssetOracle
/// @notice Interface for Orion-compatible asset oracles.
interface IAssetOracle {
    /// @notice Returns the last stored price, no state change.
    /// @return The last stored price.
    function price() external view returns (uint256);

    /// @notice Query an external feed and store the new price
    /// @return newPrice The value just stored.
    function update() external returns (uint256 newPrice);
}
