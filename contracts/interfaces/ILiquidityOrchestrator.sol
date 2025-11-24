// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";
import "./IExecutionAdapter.sol";

/// @title ILiquidityOrchestrator
/// @notice Interface for the liquidity orchestrator
/// @author Orion Finance
interface ILiquidityOrchestrator is AutomationCompatibleInterface {
    /// @notice Upkeep phase enum for liquidity orchestration
    enum LiquidityUpkeepPhase {
        Idle,
        SellingLeg,
        BuyingLeg,
        FulfillDepositAndRedeem
    }

    /// @notice Returns the current upkeep phase
    /// @return The current LiquidityUpkeepPhase
    function currentPhase() external view returns (LiquidityUpkeepPhase);

    /// @notice Returns the target buffer ratio
    /// @return The target buffer ratio
    function targetBufferRatio() external view returns (uint256);

    /// @notice Updates the minibatch size for fulfill deposit and redeem processing
    /// @param _minibatchSize The new minibatch size
    function updateMinibatchSize(uint8 _minibatchSize) external;

    /// @notice Updates the Chainlink Automation Registry address
    /// @param newAutomationRegistry The new automation registry address
    function updateAutomationRegistry(address newAutomationRegistry) external;

    /// @notice Sets the internal states orchestrator address
    /// @dev Can only be called by the contract owner
    /// @param _internalStatesOrchestrator The address of the internal states orchestrator
    function setInternalStatesOrchestrator(address _internalStatesOrchestrator) external;

    /// @notice Sets the target buffer ratio
    /// @param _targetBufferRatio The new target buffer ratio
    /// @dev Also sets slippage tolerance to 50% of targetBufferRatio across all execution adapters
    function setTargetBufferRatio(uint256 _targetBufferRatio) external;

    /// @notice Claim protocol fees with specified amount
    /// @dev Called by the Owner to claim a specific amount of protocol fees
    /// @param amount The amount of protocol fees to claim
    function claimProtocolFees(uint256 amount) external;

    /// @notice Register or replace the execution adapter for an asset.
    /// @param asset The address of the asset.
    /// @param adapter The execution adapter for the asset.
    /// @dev Can only be called by the Orion Config contract.
    function setExecutionAdapter(address asset, IExecutionAdapter adapter) external;

    /// @notice Return deposit funds to a user who cancelled their deposit request
    /// @dev Called by vault contracts when users cancel deposit requests
    /// @param user The user to return funds to
    /// @param amount The amount to return
    function returnDepositFunds(address user, uint256 amount) external;

    /// @notice Transfer pending curator fees to a vault owner
    /// @dev Called by vault contracts when vault owners claim their fees
    /// @param amount The amount of fees to transfer
    function transferCuratorFees(uint256 amount) external;

    /// @notice Transfer redemption funds to a user after shares are burned
    /// @dev Called by vault contracts when processing redemption requests
    /// @param user The user to transfer funds to
    /// @param amount The amount of underlying assets to transfer
    function transferRedemptionFunds(address user, uint256 amount) external;

    /// @notice Deposits underlying assets to the liquidity orchestrator buffer
    /// @dev Can only be called by the owner. Increases the buffer amount by the deposited amount.
    /// @param amount The amount of underlying assets to deposit
    function depositLiquidity(uint256 amount) external;

    /// @notice Withdraws underlying assets from the liquidity orchestrator buffer
    /// @dev Can only be called by the owner. Decreases the buffer amount by the withdrawn amount.
    ///      Includes safety checks to prevent predatory withdrawals that could break protocol operations.
    /// @param amount The amount of underlying assets to withdraw
    function withdrawLiquidity(uint256 amount) external;

    /// @notice Synchronous redemption for decommissioned vaults
    /// @dev Called by vault contracts to process synchronous redemptions for LPs with share tokens
    /// @param assets The amount of underlying assets to withdraw
    /// @param receiver The address to receive the underlying assets
    function withdraw(uint256 assets, address receiver) external;

    /// @notice Advances the idle phase
    /// @dev Called by the internal states orchestrator to advance the idle phase
    function advanceIdlePhase() external;

    /// @notice Pauses the contract
    /// @dev Can only be called by OrionConfig for emergency situations
    function pause() external;

    /// @notice Unpauses the contract
    /// @dev Can only be called by OrionConfig after resolving emergency
    function unpause() external;
}
