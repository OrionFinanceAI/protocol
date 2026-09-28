// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @dev Minimal LO stub so OrionConfig.isSystemIdle() succeeds in unit tests.
contract MockIdleLiquidityOrchestrator {
    enum LiquidityUpkeepPhase {
        Idle,
        Committed,
        Selling,
        Buying,
        Settling
    }

    function currentPhase() external pure returns (LiquidityUpkeepPhase) {
        return LiquidityUpkeepPhase.Idle;
    }
}
