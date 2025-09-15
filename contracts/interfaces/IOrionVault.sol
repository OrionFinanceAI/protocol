// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "./IOrionConfig.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title IOrionVault
/// @notice Interface for Orion vaults
/// @author Orion Finance
interface IOrionVault is IERC4626 {
    // --------- ERRORS ---------

    /// @notice External synchronous calls are disabled in the current context.
    error SynchronousCallDisabled();

    // --------- EVENTS ---------

    /// @notice A deposit request has been made by a user.
    /// @param sender The address of the user making the deposit request.
    /// @param assets The amount of assets being deposited.
    event DepositRequest(address indexed sender, uint256 indexed assets);

    /// @notice A deposit request has been cancelled.
    /// @param user The address of the user whose deposit request was cancelled.
    /// @param amount The amount of assets that were requested for deposit.
    event DepositRequestCancelled(address indexed user, uint256 indexed amount);

    /// @notice A redemption request has been made by a user.
    /// @param sender The address of the user making the redemption request.
    /// @param shares The number of shares being redeemed.
    event RedeemRequest(address indexed sender, uint256 indexed shares);

    /// @notice A redemption request has been cancelled.
    /// @param user The address of the user whose redemption request was cancelled.
    /// @param shares The number of shares that were requested for redemption.
    event RedeemRequestCancelled(address indexed user, uint256 indexed shares);

    /// @notice The curator has been updated.
    /// @param newCurator The new curator address.
    event CuratorUpdated(address indexed newCurator);

    /// @notice The fee model has been updated.
    /// @param mode The new calculation mode.
    /// @param performanceFee The new performance fee in basis points.
    /// @param managementFee The new management fee in basis points.
    event FeeModelUpdated(uint8 indexed mode, uint16 indexed performanceFee, uint16 indexed managementFee);

    /// @notice A deposit request has been processed and completed.
    /// @param user The address of the user whose deposit was processed.
    /// @param amount The amount of assets that were deposited.
    /// @param shares The number of shares that were minted.
    event Deposit(address indexed user, uint256 indexed amount, uint256 indexed shares);

    /// @notice A redemption request has been processed and completed.
    /// @param user The address of the user whose redemption was processed.
    /// @param assets The amount of assets that were withdrawn.
    /// @param shares The number of shares that were redeemed.
    event Withdraw(address indexed user, uint256 indexed assets, uint256 indexed shares);

    /// @notice Curator fees have been accrued for a specific epoch.
    /// @param epoch The epoch for which fees were accrued.
    /// @param feeAmount The amount of fees accrued in underlying asset units.
    /// @param pendingCuratorFees The total pending curator fees in underlying asset units.
    event CuratorFeesAccrued(uint256 indexed epoch, uint256 indexed feeAmount, uint256 indexed pendingCuratorFees);

    // --------- GETTERS ---------

    /// @notice Orion config getter
    /// @return The Orion config contract address
    function config() external view returns (IOrionConfig);

    /// @notice Vault owner getter
    /// @return The vault owner address
    function vaultOwner() external view returns (address);

    /// @notice Curator getter
    /// @return The curator address
    function curator() external view returns (address);

    /// @notice Pending curator fees getter
    /// @return Pending curator fees amount
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

    /// @notice Convert assets to shares with point in time total assets.
    /// @param assets The amount of assets to convert.
    /// @param pointInTimeTotalAssets The point in time total assets.
    /// @param rounding The rounding mode.
    /// @return The amount of shares.
    function convertToSharesWithPITTotalAssets(
        uint256 assets,
        uint256 pointInTimeTotalAssets,
        Math.Rounding rounding
    ) external view returns (uint256);

    /// --------- LP FUNCTIONS ---------

    /// @notice Submit an asynchronous deposit request.
    /// @dev No share tokens are minted immediately. The specified amount of underlying tokens
    ///      is transferred to the liquidity orchestrator for centralized liquidity management.
    /// @param assets The amount of the underlying asset to deposit.
    function requestDeposit(uint256 assets) external;

    /// @notice Cancel a previously submitted deposit request.
    /// @dev Allows LPs to withdraw their funds before any share tokens are minted.
    ///      The request must still have enough balance remaining to cover the cancellation.
    ///      Funds are returned from the liquidity orchestrator to the LP.
    /// @param amount The amount of funds to withdraw.
    function cancelDepositRequest(uint256 amount) external;

    /// @notice Submit a redemption request.
    /// @dev No share tokens are burned immediately. The specified amount of share tokens
    ///      is transferred to the vault.
    /// @param shares The amount of the share tokens to withdraw.
    function requestRedeem(uint256 shares) external;

    /// @notice Cancel a previously submitted redemption request.
    /// @dev Allows LPs to recover their share tokens before any burning occurs.
    ///      The request must still have enough shares remaining to cover the cancellation.
    ///      Share tokens are returned from the vault.
    /// @param shares The amount of share tokens to recover.
    function cancelRedeemRequest(uint256 shares) external;

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

    /// @notice Get the vault whitelist
    /// @return The array of whitelisted asset addresses for this vault.
    function vaultWhitelist() external view returns (address[] memory);

    /// @notice Update the fee model parameters
    /// @param mode The calculation mode for fees
    /// @param performanceFee The performance fee
    /// @param managementFee The management fee
    function updateFeeModel(uint8 mode, uint16 performanceFee, uint16 managementFee) external;

    /// @notice Claim accrued curator fees
    /// @param amount The amount of curator fees to claim
    function claimCuratorFees(uint256 amount) external;

    /// --------- INTERNAL STATES ORCHESTRATOR FUNCTIONS ---------

    /// @notice Get total pending deposit amount across all users
    /// @return Total pending deposits denominated in underlying asset units (e.g., USDC, ETH)
    /// @dev This returns asset amounts, not share amounts
    function pendingDeposit() external view returns (uint256);

    /// @notice Get total pending redemption shares across all users
    /// @return Total pending redemptions denominated in vault share units
    /// @dev This returns share amounts, not underlying asset amounts
    function pendingRedeem() external view returns (uint256);

    /// @notice Calculate the curator's fee based on total assets
    /// @param totalAssets The total assets under management
    /// @return The curator fee amount in underlying asset units
    /// @dev Warning: Calling this function mid-epoch may return inaccurate results
    ///      since fees are calculated based on the full epoch duration
    function curatorFee(uint256 totalAssets) external view returns (uint256);

    /// --------- LIQUIDITY ORCHESTRATOR FUNCTIONS ---------

    /// @notice Process all pending deposit requests and mint shares to depositors
    /// @param depositTotalAssets The total assets associated with the deposit requests
    function fulfillDeposit(uint256 depositTotalAssets) external;

    /// @notice Process all pending redemption requests and burn shares from redeemers
    /// @param redeemTotalAssets The total assets associated with the redemption requests
    function fulfillRedeem(uint256 redeemTotalAssets) external;

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
