// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { LiquidityOrchestrator } from "../LiquidityOrchestrator.sol";

/**
 * @title LiquidityOrchestratorVaultHarness
 * @notice Minimal harness for vault PVO + phase tests (EIP-170 sized).
 */
contract LiquidityOrchestratorVaultHarness is LiquidityOrchestrator {
    function exposed_processSingleVaultOperations(address vaultAddress, VaultState memory vaultState) external {
        _processSingleVaultOperations(vaultAddress, vaultState);
    }

    function h_setEpochStateCommitment(bytes32 commitment) external {
        _currentEpoch.epochStateCommitment = commitment;
    }

    function h_setPhase(LiquidityUpkeepPhase phase) external {
        currentPhase = phase;
    }

    function h_setMinibatchSize(uint8 size) external {
        minibatchSize = size;
    }

    function h_setCurrentMinibatchIndex(uint8 index) external {
        currentMinibatchIndex = index;
    }

    function h_setVaultsEpoch(address[] calldata vaults) external {
        delete _currentEpoch.vaultsEpoch;
        for (uint256 i = 0; i < vaults.length; ++i) {
            _currentEpoch.vaultsEpoch.push(vaults[i]);
        }
    }

    function h_executeSell(address asset, uint256 sharesAmount, uint256 estimatedUnderlyingAmount) external {
        this._executeSell(asset, sharesAmount, estimatedUnderlyingAmount);
    }

    function h_executeBuy(address asset, uint256 sharesAmount, uint256 estimatedUnderlyingAmount) external {
        this._executeBuy(asset, sharesAmount, estimatedUnderlyingAmount);
    }
}
