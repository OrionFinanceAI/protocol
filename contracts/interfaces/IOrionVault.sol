// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "./IOrionConfig.sol";

interface IOrionVault is IERC4626 {
    // Initialization
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

    // LP Functions
    function requestDeposit(uint256 amount) external;
    function requestWithdraw(uint256 shares) external;
    function cancelDepositRequest(uint256 amount) external;

    // Internal States Orchestrator Functions
    function getPendingDeposits() external view returns (uint256);
    function getPendingWithdrawals() external view returns (uint256);

    // Liquidity Orchestrator Functions
    function processDepositRequests() external;
    function processWithdrawRequests() external;
}
