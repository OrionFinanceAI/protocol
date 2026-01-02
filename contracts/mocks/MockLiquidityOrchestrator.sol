// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/**
 * @title MockLiquidityOrchestrator
 * @notice Minimal mock of LiquidityOrchestrator for cross-asset E2E testing
 * @dev Only implements methods needed for cross-asset execution adapter tests
 */
contract MockLiquidityOrchestrator {
    address public config;
    uint256 public slippageToleranceValue = 200; // 2% in basis points

    constructor(address _config) {
        config = _config;
    }

    function slippageTolerance() external view returns (uint256) {
        return slippageToleranceValue;
    }

    function setSlippageTolerance(uint256 _tolerance) external {
        slippageToleranceValue = _tolerance;
    }

    // Allow contract to receive ETH (needed for impersonation in tests)
    receive() external payable {}
}
