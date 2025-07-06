// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

interface IRebalancingEngine {
    /// @notice Executes a buy order for a given asset and amount.
    /// @param asset The address of the asset to buy.
    /// @param amount The amount of the asset to buy.
    function executeBuy(address asset, uint256 amount) external;

    /// @notice Executes a sell order for a given asset and amount.
    /// @param asset The address of the asset to sell.
    /// @param amount The amount of the asset to sell.
    function executeSell(address asset, uint256 amount) external;
}
