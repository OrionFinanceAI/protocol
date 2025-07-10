// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @title IOracleRegistry
/// @notice Interface for managing asset price oracles
interface IOracleRegistry {
    /// @notice Return the price of the given asset.
    /// @param asset The address of the asset.
    /// @return The price of the asset, normalized to 18 decimals.
    /// @dev The asset shall be whitelisted in the OrionConfig contract.
    ///      Returned value is always expected to have 18 decimals.
    function getPrice(address asset) external view returns (uint256);
}
