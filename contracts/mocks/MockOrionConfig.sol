// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/**
 * @title MockOrionConfig
 * @notice Minimal mock of OrionConfig for cross-asset E2E testing
 * @dev Only implements methods needed for cross-asset execution adapter tests
 */
contract MockOrionConfig {
    address public immutable UNDERLYING_ASSET;
    address public admin;
    address public liquidityOrchestrator;
    address public priceAdapterRegistryAddress;
    uint256 public slippageTolerance = 200; // 2% in basis points
    mapping(address => uint8) private tokenDecimals;

    constructor(address _underlyingAsset) {
        UNDERLYING_ASSET = _underlyingAsset;
        admin = msg.sender;
        liquidityOrchestrator = msg.sender;
    }

    function underlyingAsset() external view returns (address) {
        return UNDERLYING_ASSET;
    }

    function priceAdapterRegistry() external view returns (address) {
        return priceAdapterRegistryAddress;
    }

    function getSlippageTolerance() external view returns (uint256) {
        return slippageTolerance;
    }

    function priceAdapterDecimals() external pure returns (uint8) {
        return 14; // Protocol standard for price adapter decimals
    }

    function getTokenDecimals(address token) external view returns (uint8) {
        uint8 decimals = tokenDecimals[token];
        return decimals == 0 ? 18 : decimals; // Default to 18 if not set
    }

    // Mock helpers for testing
    function setSlippageTolerance(uint256 _tolerance) external {
        slippageTolerance = _tolerance;
    }

    function setLiquidityOrchestrator(address _orchestrator) external {
        liquidityOrchestrator = _orchestrator;
    }

    function setPriceAdapterRegistry(address _registry) external {
        priceAdapterRegistryAddress = _registry;
    }

    function setTokenDecimals(address token, uint8 decimals) external {
        tokenDecimals[token] = decimals;
    }
}
