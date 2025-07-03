// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

/// @title IOracleRegistry
/// @notice Interface for managing asset price oracles
interface IOracleRegistry {
    /// @notice Owner registers or replaces the oracle for an asset
    /// @param asset The address of the asset
    /// @param oracle The address of the oracle to register
    function setOracle(address asset, address oracle) external;

    /// @notice Return the price of the given whitelisted asset with respect to the base asset.
    function price(address asset) external view returns (uint256);
}
