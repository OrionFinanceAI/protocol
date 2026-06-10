// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { IExecutionAdapter } from "../interfaces/IExecutionAdapter.sol";
import { LiquidityOrchestrator } from "../LiquidityOrchestrator.sol";

/**
 * @title LiquidityOrchestratorHarness
 * @notice Test harness that exposes internal helper functions for direct testing
 */
contract LiquidityOrchestratorHarness is LiquidityOrchestrator {
    function exposed_calculateMaxWithSlippage(uint256 estimatedAmount) external view returns (uint256) {
        return _calculateMaxWithSlippage(estimatedAmount);
    }

    function exposed_calculateMinWithSlippage(uint256 estimatedAmount) external view returns (uint256) {
        return _calculateMinWithSlippage(estimatedAmount);
    }

    function exposed_processSingleVaultOperations(
        address vaultAddress,
        bool processRedeem,
        uint256 totalAssetsForDeposit,
        uint256 totalAssetsForRedeem,
        uint256 finalTotalAssets,
        uint256 managementFee,
        uint256 performanceFee,
        address[] memory tokens,
        uint256[] memory shares
    ) external {
        _processSingleVaultOperations(
            vaultAddress,
            processRedeem,
            totalAssetsForDeposit,
            totalAssetsForRedeem,
            finalTotalAssets,
            managementFee,
            performanceFee,
            tokens,
            shares
        );
    }

    function exposed_processMinibatchSell(SellLegOrders memory sellLeg) external {
        _processMinibatchSell(sellLeg);
    }

    function exposed_setLegUpkeepState(
        LiquidityUpkeepPhase phase,
        uint8 minibatchIndex,
        uint16 completedInMinibatch
    ) external {
        currentPhase = phase;
        currentMinibatchIndex = minibatchIndex;
        completedInCurrentMinibatch = completedInMinibatch;
    }

    function exposed_registerExecutionAdapter(address asset, address adapter) external {
        executionAdapterOf[asset] = IExecutionAdapter(adapter);
    }
}
