// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "./IOrionConfig.sol";

interface IOrionVault is IERC4626 {
    function initialize(
        address curatorAddress,
        IOrionConfig configAddress,
        string calldata name,
        string calldata symbol
    ) external;

    // State variables (public getters)
    function config() external view returns (IOrionConfig);
    function curator() external view returns (address);
    function deployer() external view returns (address);
    function sharePrice() external view returns (uint256);

    // LP Functions
    function requestDeposit(uint256 amount) external;
    function requestWithdraw(uint256 shares) external;
    function withdrawDepositRequest(uint256 amount) external;

    // Internal States Orchestrator Functions
    function setSharePrice(uint256 newPrice) external;
    function setTotalAssets(uint256 newTotalAssets) external;

    // State query functions for efficient batch processing
    function getPendingDeposits() external view returns (uint256);
    function getPendingWithdrawals() external view returns (uint256);

    /// @notice Update vault state based on market performance and pending operations
    /// @param newSharePrice The new share price after P&L calculation
    /// @param newTotalAssets The new total assets after processing deposits/withdrawals
    /// @param pnlAmount The profit/loss amount for this update period
    function updateVaultState(uint256 newSharePrice, uint256 newTotalAssets, uint256 pnlAmount) external;

    // Liquidity Orchestrator Functions
    function processDepositRequests() external;
    function processWithdrawRequests() external;
}
