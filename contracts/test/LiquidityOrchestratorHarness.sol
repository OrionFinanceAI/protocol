// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { LiquidityOrchestrator } from "../LiquidityOrchestrator.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

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

    /// @notice Test-only: replace vaultsEpoch for the current epoch
    function h_setVaultsEpoch(address[] calldata vaults) external {
        delete _currentEpoch.vaultsEpoch;
        for (uint256 i = 0; i < vaults.length; ++i) {
            _currentEpoch.vaultsEpoch.push(vaults[i]);
        }
    }

    /// @notice Test-only: run PVO minibatch + epoch-end gate (mirrors performUpkeep PVO branch, no ZK verify)
    /// @param vaults Vault states aligned with vaultsEpoch indices
    /// @param nettedRebalanceVolumeUnderlying Passed through to EpochEnd when completing
    function h_processPvoMinibatchWithEpochEnd(
        VaultState[] memory vaults,
        uint256 nettedRebalanceVolumeUnderlying
    ) external {
        _processMinibatchVaultsOperations(vaults);
        _maybeEpochEndAfterPvo(nettedRebalanceVolumeUnderlying);
    }

    /**
     * @notice Test-only: advance PVO minibatch index using the same completion predicate as
     *         `_processMinibatchVaultsOperations`, without vault I/O (avoids gas caps for wrap tests).
     * @dev Mirrors: i0/i1 from currentMinibatchIndex*minibatchSize, ++index (uint8 wrap), Idle iff
     *      i1 >= vaultsEpochLength. Then applies the Idle epoch-end gate.
     * @param vaultsEpochLength Simulated `_currentEpoch.vaultsEpoch.length`
     * @param nettedRebalanceVolumeUnderlying Passed through to EpochEnd when completing
     */
    function h_advancePvoIndexLikeProcessMinibatch(
        uint256 vaultsEpochLength,
        uint256 nettedRebalanceVolumeUnderlying
    ) external {
        uint16 i0 = uint16(currentMinibatchIndex) * uint16(minibatchSize);
        uint16 i1 = i0 + uint16(minibatchSize);
        // Production uses checked ++ (panic at 255); wrap this in unchecked so the test can
        // assert the Idle gate ignores a uint8 wrap mid-PVO (the old `index == 0` footgun).
        unchecked {
            ++currentMinibatchIndex;
        }

        if (i1 > vaultsEpochLength || i1 == vaultsEpochLength) {
            currentPhase = LiquidityUpkeepPhase.Idle;
            currentMinibatchIndex = 0;
            completedInCurrentMinibatch = 0;
            // Skip _nextUpdateTime (private); not required for epoch-end gate assertions
        }

        _maybeEpochEndAfterPvo(nettedRebalanceVolumeUnderlying);
    }

    function _maybeEpochEndAfterPvo(uint256 nettedRebalanceVolumeUnderlying) private {
        if (currentPhase == LiquidityUpkeepPhase.Idle) {
            address[] memory failedTokens = _failedEpochTokens;
            delete _failedEpochTokens;
            config.completeAssetsRemoval(failedTokens);
            emit EventsLib.EpochEnd(epochCounter, nettedRebalanceVolumeUnderlying);
            ++epochCounter;
        }
    }
}
