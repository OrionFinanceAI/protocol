// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "./IPriceAdapter.sol";

/// @title IPriceAdapterRegistry
interface IPriceAdapterRegistry {
    /// @notice Register or replace the price adapter for an asset.
    /// @param asset The address of the asset.
    /// @param adapter The price adapter for the asset.
    function setPriceAdapter(address asset, IPriceAdapter adapter) external;

    /// @notice Unregister the price adapter for an asset.
    /// @param asset The address of the asset.
    function unsetPriceAdapter(address asset) external;

    /// @notice Returns the price of the given asset via its assigned price adapter.
    /// @param asset The address of the asset.
    /// @return The price of the asset, normalized to 18 decimals.
    /// @dev The asset shall be whitelisted in the OrionConfig contract,
    ///      therefore assigned an adapter in `adapterOf`.
    ///      Returned value is always expected to have 18 decimals.
    function getPrice(address asset) external view returns (uint256);
}
