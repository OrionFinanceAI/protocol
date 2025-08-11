// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "./IOrionConfig.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title IOrionVault
interface IOrionVault is IERC4626 {
    // State variables (public getters)
    function config() external view returns (IOrionConfig);
    function vaultOwner() external view returns (address);
    function curator() external view returns (address);
    function pendingCuratorFees() external view returns (uint256);

    /// @notice Convert shares to assets with point in time total assets.
    /// @param shares The amount of shares to convert.
    /// @param pointInTimeTotalAssets The point in time total assets.
    /// @param rounding The rounding mode.
    /// @return The amount of assets.
    function convertToAssetsWithPITTotalAssets(
        uint256 shares,
        uint256 pointInTimeTotalAssets,
        Math.Rounding rounding
    ) external view returns (uint256);

    /// --------- LP FUNCTIONS ---------

    /// @notice Submit an asynchronous deposit request.
    /// @dev No share tokens are minted immediately. The specified amount of underlying tokens
    ///      is transferred to the liquidity orchestrator for centralized liquidity management.
    ///      LPs can later cancel this request to withdraw their funds before any minting occurs.
    /// @param amount The amount of the underlying asset to deposit.
    function requestDeposit(uint256 amount) external;

    /// @notice Cancel a previously submitted deposit request.
    /// @dev Allows LPs to withdraw their funds before any share tokens are minted.
    ///      The request must still have enough balance remaining to cover the cancellation.
    ///      Funds are returned from the liquidity orchestrator to the LP.
    /// @param amount The amount of funds to withdraw.
    function cancelDepositRequest(uint256 amount) external;

    /// @notice Submit an asynchronous withdrawal request.
    /// @dev No share tokens are burned immediately. The specified amount of share tokens
    ///      is transferred to the liquidity orchestrator for centralized liquidity management.
    ///      LPs can later cancel this request to withdraw their funds before any burning occurs.
    /// @param shares The amount of the share tokens to withdraw.
    function requestWithdraw(uint256 shares) external;

    /// @notice Cancel a previously submitted withdrawal request.
    /// @dev Allows LPs to recover their share tokens before any burning occurs.
    ///      The request must still have enough shares remaining to cover the cancellation.
    ///      Share tokens are returned from the liquidity orchestrator.
    /// @param shares The amount of share tokens to recover.
    function cancelWithdrawRequest(uint256 shares) external;

    // --------- VAULT OWNER AND CURATOR FUNCTIONS ---------

    /// @notice Update the vault curator address
    /// @param newCurator The new curator address. Must be non-zero.
    /// @dev The curator is responsible for setting allocation strategy for the vault's assets.
    ///      This function enables vault owners to change allocation strategies by updating the curator.
    ///      This is particularly important when curators are smart contracts, not just addresses.
    function updateCurator(address newCurator) external;

    /// @notice Update the vault whitelist
    /// @param assets The new whitelist of assets.
    function updateVaultWhitelist(address[] memory assets) external;

    /// @notice Update the fee model parameters
    /// @param mode The calculation mode for fees
    /// @param performanceFee The performance fee
    /// @param managementFee The management fee
    function updateFeeModel(uint8 mode, uint16 performanceFee, uint16 managementFee) external;

    /// @notice Calculate the curator's fee based on total assets
    /// @param totalAssets The total assets under management
    /// @return The curator fee amount in underlying asset units
    /// @dev Warning: Calling this function mid-epoch may return inaccurate results
    ///      since fees are calculated based on the full epoch duration
    function curatorFee(uint256 totalAssets) external view returns (uint256);

    /// --------- INTERNAL STATES ORCHESTRATOR FUNCTIONS ---------

    /// @notice Get total pending deposit amount across all users
    /// @return Total pending deposits denominated in underlying asset units (e.g., USDC, ETH)
    /// @dev This returns asset amounts, not share amounts
    function getPendingDeposits() external view returns (uint256);

    /// @notice Get total pending withdrawal shares across all users
    /// @return Total pending withdrawals denominated in vault share units
    /// @dev This returns share amounts, not underlying asset amounts
    function getPendingWithdrawals() external view returns (uint256);

    /// --------- LIQUIDITY ORCHESTRATOR FUNCTIONS ---------

    /// @notice Process deposit requests from LPs and reset the requestor's request amount
    function processDepositRequests() external;

    /// @notice Process withdrawal requests from LPs and reset the requestor's request amount
    function processWithdrawRequests() external;

    /// @notice Update the high watermark after trades are executed
    /// @dev Shall be called by the liquidity orchestrator after portfolio rebalancing.
    ///      Updates high watermark if current share price exceeds the previous high watermark.
    ///      This is used to calculate the performance fee.
    function updateHighWaterMark() external;

    /// @notice Accrue curator fees for a specific epoch
    /// @param epoch The epoch for which to accrue fees
    /// @param feeAmount The amount of curator fees to accrue in underlying asset units
    function accrueCuratorFees(uint256 epoch, uint256 feeAmount) external;
}
