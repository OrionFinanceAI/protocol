// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";
import "./IExecutionAdapter.sol";

/// @title Liquidity Orchestrator Interface
/// @notice Interface for the Liquidity Orchestrator contract
/// @dev Defines the external interface for orchestrating transaction execution and vault state modifications
///
///      This interface defines the functions that the Liquidity Orchestrator will implement
///      to handle actual transaction execution and state writing operations, in contrast
///      to the Internal States Orchestrator which only performs read operations and estimations.
interface ILiquidityOrchestrator is AutomationCompatibleInterface {
    // Configuration functions
    function updateAutomationRegistry(address newAutomationRegistry) external;
    function updateConfig(address newConfig) external;

    // Deposit and withdrawal management functions
    function returnDepositFunds(address user, uint256 amount) external;
    function returnWithdrawShares(address user, uint256 shares) external;

    /// @notice Register or replace the execution adapter for an asset.
    /// @param asset The address of the asset.
    /// @param adapter The execution adapter for the asset.
    /// @dev Can only be called by the Orion Config contract.
    function setAdapter(address asset, IExecutionAdapter adapter) external;

    /// @notice Unregister the execution adapter for an asset.
    /// @param asset The address of the asset.
    /// @dev Can only be called by the Orion Config contract.
    function unsetAdapter(address asset) external;

    function executionAdapterOf(address asset) external view returns (IExecutionAdapter);
}
