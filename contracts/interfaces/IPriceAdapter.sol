// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @title IPriceAdapter
interface IPriceAdapter {
    /// @param asset The address of the asset to get the price for
    /// @return price (priceAdapterPrecision scaled) quote of `base` in units of `quote`.
    /// @dev The asset shall be whitelisted in the OrionConfig contract.
    function price(address asset) external view returns (uint256);
}
