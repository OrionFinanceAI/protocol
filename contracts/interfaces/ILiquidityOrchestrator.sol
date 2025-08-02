// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";
import "./IExecutionAdapter.sol";

/// @title ILiquidityOrchestrator
/// @notice Interface for orchestrating liquidity operations within the protocol.
interface ILiquidityOrchestrator is AutomationCompatibleInterface {
    /// @notice Updates the Chainlink Automation Registry address
    /// @param newAutomationRegistry The new automation registry address
    function updateAutomationRegistry(address newAutomationRegistry) external;

    /// @notice Updates the Orion Config contract address
    /// @param newConfig The new config address
    function updateConfig(address newConfig) external;

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

    /// @notice Return withdrawal shares to a user who cancelled their withdrawal request
    /// @dev Called by vault contracts when users cancel withdrawal requests
    /// @param user The user to return shares to
    /// @param shares The amount of shares to return
    function returnWithdrawShares(address user, uint256 shares) external;

    function executionAdapterOf(address asset) external view returns (IExecutionAdapter);
}
