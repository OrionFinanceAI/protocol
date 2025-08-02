// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";
import "./IOrionConfig.sol";

/// @title IInternalStateOrchestrator
interface IInternalStateOrchestrator is AutomationCompatibleInterface {
    /// @notice Returns the current epoch counter
    function epochCounter() external view returns (uint256);

    // Configuration functions
    function updateAutomationRegistry(address newAutomationRegistry) external;
    function updateConfig(address newConfig) external;

    // Rebalancing orders functions
    function getSellingOrders() external view returns (address[] memory, uint256[] memory);
    function getBuyingOrders() external view returns (address[] memory, uint256[] memory);

    // Tracking error functions
    function expectedUnderlyingSellAmount() external view returns (uint256);
    function expectedUnderlyingBuyAmount() external view returns (uint256);
}
