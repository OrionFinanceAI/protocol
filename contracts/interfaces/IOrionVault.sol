// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/interfaces/IERC4626.sol";
import "./IOrionConfig.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title IOrionVault
/// @notice Interface for Orion vaults
/// @author Orion Finance
/// @custom:security-contact security@orionfinance.ai
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

    /// @notice The strategist has been updated.
    /// @param newStrategist The new strategist address.
    event StrategistUpdated(address indexed newStrategist);

    /// @notice The fee model has been updated.
    /// @param mode The new calculation mode.
    /// @param performanceFee The new performance fee in basis points.
    /// @param managementFee The new management fee in basis points.
    event VaultFeeModelUpdated(uint8 indexed mode, uint16 indexed performanceFee, uint16 indexed managementFee);

    /// @notice A redemption request has been fulfilled.
    /// @param user The address of the user whose redemption was fulfilled.
    /// @param redeemAmount The amount of assets redeemed by the user.
    /// @param sharesBurned The number of shares burned for the user.
    event Redeem(address indexed user, uint256 indexed redeemAmount, uint256 indexed sharesBurned);

    /// @notice The vault whitelist has been updated.
    /// @param assets The new whitelist of assets.
    event VaultWhitelistUpdated(address[] assets);

    /// @notice Fees have been accrued.
    /// @param managementFee The amount of management fees accrued.
    /// @param performanceFee The amount of performance fees accrued.
    event VaultFeesAccrued(uint256 managementFee, uint256 performanceFee);

    /// @notice Fees have been claimed.
    /// @param manager The address of the manager who claimed the fees.
    /// @param feeAmount The amount of fees claimed.
    event VaultFeesClaimed(address indexed manager, uint256 feeAmount);

    /// @notice The deposit access control contract has been updated.
    /// @param newDepositAccessControl The new deposit access control contract address (address(0) = permissionless).
    event DepositAccessControlUpdated(address indexed newDepositAccessControl);

    // --------- GETTERS ---------

    /// @notice Orion config getter
    /// @return The Orion config contract address
    function config() external view returns (IOrionConfig);

    /// @notice Manager getter
    /// @return The manager address
    function manager() external view returns (address);

    /// @notice Strategist getter
    /// @return The strategist address
    function strategist() external view returns (address);

    /// @notice Pending vault fees getter
    /// @return Pending vault fees amount
    function pendingVaultFees() external view returns (uint256);

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

    /// @notice Returns the implementation address of this proxy contract
    /// @dev This function enables third-party protocol integrations to verify
    ///      that the implementation address has not been modified unexpectedly.
    ///      It reads the beacon address from the ERC-1967 storage slot and
    ///      returns the implementation address from the beacon.
    /// @return The address of the implementation contract
    function implementation() external view returns (address);

    /// --------- CONFIG FUNCTIONS ---------

    /// @notice Override intent to 100% underlying asset for decommissioning
    /// @dev Can only be called by the OrionConfig contract
    function overrideIntentForDecommissioning() external;

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

    // --------- MANAGER AND STRATEGIST FUNCTIONS ---------

    /// @notice Update the strategist address
    /// @param newStrategist The new strategist address.
    /// @dev The strategist is responsible for setting allocation logic for the vault's assets.
    ///      This function enables managers to update the strategist.
    ///      Strategist can be a smart contract or an address. It is the FULL responsibility of the manager
    ///      to ensure the strategist is capable of performing its duties.
    function updateStrategist(address newStrategist) external;

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

    /// @notice Claim accrued vault fees
    /// @param amount The amount of vault fees to claim
    function claimVaultFees(uint256 amount) external;

    /// @notice Set deposit access control contract
    /// @param newDepositAccessControl Address of the new access control contract (address(0) = permissionless)
    /// @dev Only callable by vault manager
    ///      It is the FULL responsibility of the vault manager
    ///      to ensure the deposit access control is capable of performing its duties.
    function setDepositAccessControl(address newDepositAccessControl) external;

    /// --------- INTERNAL STATE ORCHESTRATOR FUNCTIONS ---------

    /// @notice Get total pending deposit amount across all users
    /// @param fulfillBatchSize The maximum number of requests to process per fulfill call
    /// @return Total pending deposits denominated in underlying asset units (e.g., USDC, ETH)
    /// @dev This returns asset amounts, not share amounts
    function pendingDeposit(uint256 fulfillBatchSize) external view returns (uint256);

    /// @notice Get total pending redemption shares across all users
    /// @param fulfillBatchSize The maximum number of requests to process per fulfill call
    /// @return Total pending redemptions denominated in vault share units
    /// @dev This returns share amounts, not underlying asset amounts
    function pendingRedeem(uint256 fulfillBatchSize) external view returns (uint256);

    /// @notice Calculate the vault's fee based on total assets
    /// @param totalAssets The total assets under management
    /// @return managementFee The management fee amount in underlying asset units
    /// @return performanceFee The performance fee amount in underlying asset units
    /// @dev Warning: Calling this function mid-epoch may return inaccurate results
    ///      since fees are calculated based on the full epoch duration
    function vaultFee(uint256 totalAssets) external view returns (uint256 managementFee, uint256 performanceFee);

    /// --------- LIQUIDITY ORCHESTRATOR FUNCTIONS ---------

    /// @notice Process all pending deposit requests and mint shares to depositors
    /// @param depositTotalAssets The total assets associated with the deposit requests
    function fulfillDeposit(uint256 depositTotalAssets) external;

    /// @notice Process all pending redemption requests and burn shares from redeemers
    /// @param redeemTotalAssets The total assets associated with the redemption requests
    function fulfillRedeem(uint256 redeemTotalAssets) external;

    /// @notice Accrue vault fees for a specific epoch
    /// @param managementFee The amount of management fees to accrue in underlying asset units
    /// @param performanceFee The amount of performance fees to accrue in underlying asset units
    function accrueVaultFees(uint256 managementFee, uint256 performanceFee) external;
}
