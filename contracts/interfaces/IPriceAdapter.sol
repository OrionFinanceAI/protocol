// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @title IPriceAdapter
/// @notice Interface for price adapters
/// @author Orion Finance
interface IPriceAdapter {
    /// @notice Get the price data for an asset
    /// @param asset The address of the asset to get the price for
    /// @return price The raw price of the asset
    /// @return decimals The number of decimals for the returned price
    /// @dev The asset shall be whitelisted in the OrionConfig contract.
    /// @dev The registry will handle normalization to priceAdapterDecimals.
    function getPriceData(address asset) external view returns (uint256 price, uint8 decimals);
}
