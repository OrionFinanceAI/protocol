// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @title IPriceAdapter
interface IPriceAdapter {
    /// @return price (1e18 scaled) quote of `base` in units of `quote`.
    /// @dev The asset shall be whitelisted in the OrionConfig contract.
    function price() external view returns (uint256);
}
