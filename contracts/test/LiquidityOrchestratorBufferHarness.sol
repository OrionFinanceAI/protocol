// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { LiquidityOrchestrator } from "../LiquidityOrchestrator.sol";
import { IExecutionAdapter } from "../interfaces/IExecutionAdapter.sol";

/**
 * @title LiquidityOrchestratorBufferHarness
 * @notice Thin harness for buffer/fee accrual tests (keeps execution harness under EIP-170).
 */
contract LiquidityOrchestratorBufferHarness is LiquidityOrchestrator {
    function h_setExecutionAdapter(address asset, address adapter) external {
        executionAdapterOf[asset] = IExecutionAdapter(adapter);
    }

    function h_setBufferAmount(uint256 amount) external {
        bufferAmount = amount;
    }

    function h_setPendingProtocolFees(uint256 amount) external {
        pendingProtocolFees = amount;
    }

    function h_epochDeltaAmount() external view returns (int256) {
        return _epochDeltaAmount;
    }

    function h_setEpochDeltaAmount(int256 amount) external {
        _epochDeltaAmount = amount;
    }

    function h_setPhase(LiquidityUpkeepPhase phase) external {
        currentPhase = phase;
    }

    function h_setEpochStateCommitment(bytes32 commitment) external {
        _currentEpoch.epochStateCommitment = commitment;
    }

    function h_executeSell(address asset, uint256 sharesAmount, uint256 estimatedUnderlyingAmount) external {
        this._executeSell(asset, sharesAmount, estimatedUnderlyingAmount);
    }

    function h_executeBuy(address asset, uint256 sharesAmount, uint256 estimatedUnderlyingAmount) external {
        this._executeBuy(asset, sharesAmount, estimatedUnderlyingAmount);
    }

    function h_applyBuyLegSettlement(uint256 bufferIncrease, uint256 epochProtocolFees) external {
        _applyBuyLegSettlement(bufferIncrease, epochProtocolFees);
    }
}
