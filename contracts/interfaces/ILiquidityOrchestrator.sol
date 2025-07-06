// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";

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

    // Deposit management functions
    function returnDepositFunds(address user, uint256 amount) external;
}
