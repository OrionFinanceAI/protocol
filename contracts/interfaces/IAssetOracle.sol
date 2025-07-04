// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

/// @title IAssetOracle
/// @notice Interface for Orion-compatible asset oracles.
interface IAssetOracle {
    /// @notice Return the price of 1 whitelisted asset with respect 1 base asset.
    function price() external view returns (uint256);
}
