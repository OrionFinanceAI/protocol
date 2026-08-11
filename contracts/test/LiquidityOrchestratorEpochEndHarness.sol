// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { LiquidityOrchestrator } from "../LiquidityOrchestrator.sol";
import { EventsLib } from "../libraries/EventsLib.sol";

/**
 * @title LiquidityOrchestratorEpochEndHarness
 * @notice Exposes PVO→Idle epoch-end helpers (split out so main harness fits EIP-170).
 */
contract LiquidityOrchestratorEpochEndHarness is LiquidityOrchestrator {
    function h_setPhase(LiquidityUpkeepPhase phase) external {
        currentPhase = phase;
    }

    function h_setCurrentMinibatchIndex(uint8 index) external {
        currentMinibatchIndex = index;
    }

    function h_setMinibatchSize(uint8 size) external {
        minibatchSize = size;
    }

    function h_setVaultsEpoch(address[] calldata vaults) external {
        delete _currentEpoch.vaultsEpoch;
        for (uint256 i = 0; i < vaults.length; ++i) {
            _currentEpoch.vaultsEpoch.push(vaults[i]);
        }
    }

    /// @notice Test-only: run PVO minibatch + epoch-end gate (mirrors performUpkeep PVO branch, no ZK verify)
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
     */
    function h_advancePvoIndexLikeProcessMinibatch(
        uint256 vaultsEpochLength,
        uint256 nettedRebalanceVolumeUnderlying
    ) external {
        uint16 i0 = uint16(currentMinibatchIndex) * uint16(minibatchSize);
        uint16 i1 = i0 + uint16(minibatchSize);
        unchecked {
            ++currentMinibatchIndex;
        }

        if (i1 > vaultsEpochLength || i1 == vaultsEpochLength) {
            currentPhase = LiquidityUpkeepPhase.Idle;
            currentMinibatchIndex = 0;
            completedInCurrentMinibatch = 0;
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
