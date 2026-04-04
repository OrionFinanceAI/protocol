// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @title MockUniswapV3Pool
/// @notice Minimal mock of IUniswapV3Pool for unit testing price adapters.
/// @dev Exposes only the slot0() function with a controllable sqrtPriceX96 value.
contract MockUniswapV3Pool {
    uint160 public sqrtPriceX96;
    int24 public tick;

    constructor(uint160 _sqrtPriceX96, int24 _tick) {
        sqrtPriceX96 = _sqrtPriceX96;
        tick = _tick;
    }

    function setSlot0(uint160 _sqrtPriceX96, int24 _tick) external {
        sqrtPriceX96 = _sqrtPriceX96;
        tick = _tick;
    }

    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        return (sqrtPriceX96, tick, 0, 0, 0, 0, true);
    }
}
