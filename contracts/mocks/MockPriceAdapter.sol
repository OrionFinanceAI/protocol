// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IPriceAdapter } from "../interfaces/IPriceAdapter.sol";

/// @title Price Adapter mock
/// @notice One instance per asset. Produces pseudo‑random prices for testing.
contract MockPriceAdapter is IPriceAdapter {
    // solhint-disable-next-line no-empty-blocks
    constructor() {}

    /// @inheritdoc IPriceAdapter
    function getPriceData(address) external pure returns (uint256 price, uint8 decimals) {
        return (42, 14);
    }

    /// @inheritdoc IPriceAdapter
    function validatePriceAdapter(address) external pure {
        // Mock adapter always validates successfully
    }
}
