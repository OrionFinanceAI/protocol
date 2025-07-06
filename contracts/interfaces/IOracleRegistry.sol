// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "./IPriceAdapter.sol";

/// @title IOracleRegistry
/// @notice Interface for managing asset price oracles
interface IOracleRegistry {
    /// @notice Owner registers or replaces the adapter for an asset
    /// @param asset The address of the asset
    /// @param adapter The adapter to register
    function setAdapter(address asset, IPriceAdapter adapter) external;

    /// @notice Return the price of the given asset
    /// @param asset The address of the asset
    /// @dev The asset shall be whitelisted in the OrionConfig contract.
    function getPrice(address asset) external view returns (uint256);
}
