// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";
import "./IExecutionAdapter.sol";

/// @title ILiquidityOrchestrator
interface ILiquidityOrchestrator is AutomationCompatibleInterface {
    /// @notice Upkeep phase enum for liquidity orchestration
    enum LiquidityUpkeepPhase {
        Idle,
        SellingLeg,
        BuyingLeg,
        StateUpdate
    }

    /// @notice Returns the current upkeep phase
    /// @return The current LiquidityUpkeepPhase
    function currentPhase() external view returns (LiquidityUpkeepPhase);

    /// @notice Updates the execution minibatch size
    /// @param _executionMinibatchSize The new execution minibatch size
    function updateExecutionMinibatchSize(uint8 _executionMinibatchSize) external;

    /// @notice Updates the Chainlink Automation Registry address
    /// @param newAutomationRegistry The new automation registry address
    function updateAutomationRegistry(address newAutomationRegistry) external;

    /// @notice Register or replace the execution adapter for an asset.
    /// @param asset The address of the asset.
    /// @param adapter The execution adapter for the asset.
    /// @dev Can only be called by the Orion Config contract.
    function setExecutionAdapter(address asset, IExecutionAdapter adapter) external;

    /// @notice Unregister the execution adapter for an asset.
    /// @param asset The address of the asset.
    /// @dev Can only be called by the Orion Config contract.
    function unsetExecutionAdapter(address asset) external;

    /// @notice Return deposit funds to a user who cancelled their deposit request
    /// @dev Called by vault contracts when users cancel deposit requests
    /// @param user The user to return funds to
    /// @param amount The amount to return
    function returnDepositFunds(address user, uint256 amount) external;

    /// @notice Transfer pending curator fees to a vault owner
    /// @dev Called by vault contracts when vault owners claim their fees
    /// @param amount The amount of fees to transfer
    function transferCuratorFees(uint256 amount) external;

    /// @notice Transfer withdrawal funds to a user after shares are burned
    /// @dev Called by vault contracts when processing withdrawal requests
    /// @param user The user to transfer funds to
    /// @param amount The amount of underlying assets to transfer
    function transferWithdrawalFunds(address user, uint256 amount) external;
}
