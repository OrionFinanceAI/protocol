// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { LiquidityOrchestrator } from "../LiquidityOrchestrator.sol";

/**
 * @title LiquidityOrchestratorCommitmentHarness
 * @notice Minimal harness for protocol-state commitment golden vectors (EIP-170 sized)
 */
contract LiquidityOrchestratorCommitmentHarness is LiquidityOrchestrator {
    /// @notice Test-only: expose protocol state hash for commitment golden vectors
    function exposed_buildProtocolStateHash() external view returns (bytes32) {
        return _buildProtocolStateHash();
    }
}
