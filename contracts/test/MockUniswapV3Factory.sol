// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @title MockUniswapV3Factory
/// @notice Minimal mock of IUniswapV3Factory for unit testing
contract MockUniswapV3Factory {
    /// @notice (tokenA, tokenB, fee) => pool address
    mapping(address => mapping(address => mapping(uint24 => address))) private pools;

    function setPool(address tokenA, address tokenB, uint24 fee, address pool) external {
        pools[tokenA][tokenB][fee] = pool;
        pools[tokenB][tokenA][fee] = pool;
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return pools[tokenA][tokenB][fee];
    }
}
