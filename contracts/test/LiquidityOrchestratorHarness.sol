// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { LiquidityOrchestrator } from "../LiquidityOrchestrator.sol";

/**
 * @title LiquidityOrchestratorHarness
 * @notice Test harness that exposes internal slippage helper functions for direct testing
 */
contract LiquidityOrchestratorHarness is LiquidityOrchestrator {
    function exposed_calculateMaxWithSlippage(uint256 estimatedAmount) external view returns (uint256) {
        return _calculateMaxWithSlippage(estimatedAmount);
    }

    function exposed_calculateMinWithSlippage(uint256 estimatedAmount) external view returns (uint256) {
        return _calculateMinWithSlippage(estimatedAmount);
    }
}
