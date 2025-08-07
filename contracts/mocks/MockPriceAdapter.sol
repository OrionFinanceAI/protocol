// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IPriceAdapter } from "../interfaces/IPriceAdapter.sol";

/// @title Price Adapter mock
/// @notice One instance per asset. Produces pseudo‑random prices for testing.
contract MockPriceAdapter is IPriceAdapter {
    constructor() {}

    /// @inheritdoc IPriceAdapter
    function getPriceData(address asset) external view returns (uint256 price, uint8 decimals) {
        // *** Mock randomness *** — DO NOT use in production, returning values between 1 and 100
        uint256 mockPrice = (uint256(keccak256(abi.encodePacked(blockhash(block.number - 1), block.timestamp, asset))) %
            100) + 1;
        return (mockPrice, 18); // Mock price with 18 decimals
    }
}
