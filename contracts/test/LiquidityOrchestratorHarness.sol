// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import { LiquidityOrchestrator } from "../LiquidityOrchestrator.sol";
import { IExecutionAdapter } from "../interfaces/IExecutionAdapter.sol";

/**
 * @title LiquidityOrchestratorHarness
 * @notice Test harness that exposes internal helper functions for direct testing
 * @dev Epoch-end / slippage helpers live in dedicated harnesses to stay under EIP-170.
 */
contract LiquidityOrchestratorHarness is LiquidityOrchestrator {
    function exposed_processSingleVaultOperations(address vaultAddress, VaultState memory vaultState) external {
        _processSingleVaultOperations(vaultAddress, vaultState);
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

    /// @notice Test-only: set execution adapter without going through OrionConfig
    function h_setExecutionAdapter(address asset, address adapter) external {
        executionAdapterOf[asset] = IExecutionAdapter(adapter);
    }

    /// @notice Test-only: seed pending protocol fees for claim tests
    function h_setPendingProtocolFees(uint256 amount) external {
        pendingProtocolFees = amount;
    }

    /// @notice Test-only: read deferred epoch execution dust
    function h_epochDeltaAmount() external view returns (int256) {
        return _epochDeltaAmount;
    }

    /// @notice Test-only: seed deferred epoch execution dust
    function h_setEpochDeltaAmount(int256 amount) external {
        _epochDeltaAmount = amount;
    }

    /// @notice Test-only: seed buffer amount
    function h_setBufferAmount(uint256 amount) external {
        bufferAmount = amount;
    }

    /// @notice Test-only: invoke `_executeSell` via self-call (onlySelf)
    function h_executeSell(address asset, uint256 sharesAmount, uint256 estimatedUnderlyingAmount) external {
        this._executeSell(asset, sharesAmount, estimatedUnderlyingAmount);
    }

    /// @notice Test-only: invoke `_executeBuy` via self-call (onlySelf)
    function h_executeBuy(address asset, uint256 sharesAmount, uint256 estimatedUnderlyingAmount) external {
        this._executeBuy(asset, sharesAmount, estimatedUnderlyingAmount);
    }

    /// @notice Test-only: invoke Buy→PVO settlement helper
    function h_applyBuyLegSettlement(uint256 bufferIncrease, uint256 epochProtocolFees) external {
        _applyBuyLegSettlement(bufferIncrease, epochProtocolFees);
    }

    /// @notice Test-only: run sell minibatch processing
    function h_processMinibatchSell(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata estimated
    ) external {
        SellLegOrders memory sellLeg = SellLegOrders({
            sellingTokens: tokens,
            sellingAmounts: amounts,
            sellingEstimatedUnderlyingAmounts: estimated
        });
        _processMinibatchSell(sellLeg);
    }

    /// @notice Test-only: run buy minibatch processing
    function h_processMinibatchBuy(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata estimated
    ) external {
        BuyLegOrders memory buyLeg = BuyLegOrders({
            buyingTokens: tokens,
            buyingAmounts: amounts,
            buyingEstimatedUnderlyingAmounts: estimated
        });
        _processMinibatchBuy(buyLeg);
    }

    /// @notice Test-only: trigger empty-epoch start (no vaults → defer next update)
    function h_handleStart() external {
        _handleStart();
    }

    /// @notice Test-only: set completedInCurrentMinibatch cursor
    function h_setCompletedInCurrentMinibatch(uint8 value) external {
        completedInCurrentMinibatch = value;
    }
}
