// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";
import "./IOrionConfig.sol";

/// @title Internal State Orchestrator Interface
/// @notice Interface for the Internal States Orchestrator contract
/// @dev Defines the external interface for orchestrating internal state transitions
interface IInternalStateOrchestrator is AutomationCompatibleInterface {
    // State variables
    function nextUpdateTime() external view returns (uint256);
    function updateInterval() external view returns (uint256);
    function automationRegistry() external view returns (address);
    function config() external view returns (IOrionConfig);

    // Configuration functions
    function updateAutomationRegistry(address newAutomationRegistry) external;
    function updateConfig(address newConfig) external;
}
