// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

/// @title IOracleRegistry
/// @notice Interface for managing asset price oracles
interface IOracleRegistry {
    /// @notice Owner registers or replaces the oracle for an asset
    /// @param asset The address of the asset
    /// @param oracle The address of the oracle to register
    function setOracle(address asset, address oracle) external;

    /// @notice Gets the current price for an asset from its oracle
    /// @param asset The address of the asset
    /// @return The current price from the oracle
    function price(address asset) external view returns (uint256);

    /// @notice Updates and returns the new price for an asset from its oracle
    /// @param asset The address of the asset
    /// @return newPrice The updated price from the oracle
    function update(address asset) external returns (uint256 newPrice);
}
