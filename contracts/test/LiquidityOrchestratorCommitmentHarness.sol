// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { LiquidityOrchestrator } from "../LiquidityOrchestrator.sol";

/**
 * @title LiquidityOrchestratorCommitmentHarness
 * @notice Minimal harness for protocol-state commitment golden vectors (EIP-170 sized)
 */
contract LiquidityOrchestratorCommitmentHarness is LiquidityOrchestrator {
    /// @notice Test-only: expose protocol state hash (emits EpochProtocolStateHashed)
    function exposed_buildProtocolStateHash() external returns (bytes32) {
        return _buildProtocolStateHash();
    }

    /// @notice Test-only: expose minibatch leg-failure recommit path
    function exposed_handleMinibatchLegFailure(address token) external {
        _handleMinibatchLegFailure(token);
    }

    /// @notice Test-only: simulate post-upgrade zeroed fee-epoch clock slot
    function exposed_clearLastEpochStartTimestamp() external {
        lastEpochStartTimestamp = 0;
    }

    /// @notice Test-only: seed fee-epoch clock as if a prior epoch had started
    function exposed_setLastEpochStartTimestamp(uint256 timestamp) external {
        lastEpochStartTimestamp = timestamp;
    }
}
