// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { LiquidityOrchestrator } from "../LiquidityOrchestrator.sol";

/**
 * @title LiquidityOrchestratorHarness
 * @notice Test harness that exposes internal helper functions for direct testing
 * @dev Epoch-end / slippage helpers live in dedicated harnesses to stay under EIP-170.
 */
contract LiquidityOrchestratorHarness is LiquidityOrchestrator {
    /// @notice Test-only: set upkeep phase
    function h_setPhase(LiquidityUpkeepPhase phase) external {
        currentPhase = phase;
    }

    /// @notice Test-only: set PVO/sell/buy minibatch index
    function h_setCurrentMinibatchIndex(uint8 index) external {
        currentMinibatchIndex = index;
    }

    /// @notice Test-only: set fulfill minibatch size (bypasses idle/owner checks)
    function h_setMinibatchSize(uint8 size) external {
        minibatchSize = size;
    }

    /// @notice Test-only: set execution minibatch size (bypasses idle/owner checks)
    function h_setExecutionMinibatchSize(uint8 size) external {
        executionMinibatchSize = size;
    }

    /// @notice Test-only: replace vaultsEpoch for the current epoch
    function h_setVaultsEpoch(address[] calldata vaults) external {
        delete _currentEpoch.vaultsEpoch;
        for (uint256 i = 0; i < vaults.length; ++i) {
            _currentEpoch.vaultsEpoch.push(vaults[i]);
        }
    }

    /// @notice Test-only: seed commitment minibatch size (bypasses ACL / Idle)
    function h_setCommitmentMinibatchSize(uint8 size) external {
        commitmentMinibatchSize = size;
    }

    /// @notice Test-only: read commitment batch cursor
    function h_commitmentBatchIndex() external view returns (uint16) {
        return _commitmentBatchIndex;
    }

    /// @notice Test-only: seed failed epoch tokens for removal-at-epoch-end
    function h_setFailedEpochTokens(address[] calldata tokens) external {
        delete _failedEpochTokens;
        for (uint256 i = 0; i < tokens.length; ++i) {
            _failedEpochTokens.push(tokens[i]);
        }
    }

    /// @notice Test-only: set epoch state commitment used by `_verifyPerformData`
    function h_setEpochStateCommitment(bytes32 commitment) external {
        _currentEpoch.epochStateCommitment = commitment;
    }

    /// @notice Test-only: set completedInCurrentMinibatch cursor
    function h_setCompletedInCurrentMinibatch(uint8 value) external {
        completedInCurrentMinibatch = value;
    }
}
