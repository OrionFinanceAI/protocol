// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";
import "./IOrionConfig.sol";

/// @title IInternalStateOrchestrator
interface IInternalStateOrchestrator is AutomationCompatibleInterface {
    /// @notice Returns the current epoch counter
    function epochCounter() external view returns (uint256);

    /// @notice Updates the Chainlink Automation Registry address
    /// @param newAutomationRegistry The new automation registry address
    function updateAutomationRegistry(address newAutomationRegistry) external;

    /// @notice Updates the Orion Config contract address
    /// @param newConfig The new config address
    function updateConfig(address newConfig) external;

    /// @notice Get the selling orders
    /// @return tokens The tokens to sell
    /// @return amounts The amounts to sell in shares (converted from underlying assets)
    function getSellingOrders() external view returns (address[] memory, uint256[] memory);

    /// @notice Get the buying orders
    /// @return tokens The tokens to buy
    /// @return amounts The amounts to buy in underlying assets (as expected by LiquidityOrchestrator)
    function getBuyingOrders() external view returns (address[] memory, uint256[] memory);

    // Tracking error functions
    function expectedUnderlyingSellAmount() external view returns (uint256);
    function expectedUnderlyingBuyAmount() external view returns (uint256);
}
