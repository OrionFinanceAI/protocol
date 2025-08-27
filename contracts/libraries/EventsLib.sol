// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @title EventsLib
/// @notice Centralized library of events emitted throughout the Orion protocol.
/// @author Orion Finance
library EventsLib {
    // ============================
    // === Orion Config Events ===
    // ============================

    /// @notice A new asset has been whitelisted for protocol usage.
    /// @param asset The address of the whitelisted asset.
    event WhitelistedAssetAdded(address indexed asset);

    /// @notice An asset has been removed from the whitelist.
    /// @param asset The address of the removed asset.
    event WhitelistedAssetRemoved(address indexed asset);

    /// @notice A new Orion Vault has been registered in the protocol.
    /// @param vault The address of the added vault.
    event OrionVaultAdded(address indexed vault);

    /// @notice An Orion Vault has been removed from the protocol registry.
    /// @param vault The address of the removed vault.
    event OrionVaultRemoved(address indexed vault);

    /// @notice The risk-free rate has been updated.
    /// @param riskFreeRate The new risk-free rate in basis points.
    event RiskFreeRateUpdated(uint16 indexed riskFreeRate);

    // =======================
    // === Vault Lifecycle ===
    // =======================

    /// @notice A new order has been submitted by a curator.
    /// @param curator The address of the curator who submitted the order.
    event OrderSubmitted(address indexed curator);

    /// @notice A deposit request has been processed and completed.
    /// @param user The address of the user whose deposit was processed.
    /// @param amount The amount of assets that were deposited.
    event DepositProcessed(address indexed user, uint256 indexed amount);

    /// @notice A redemption request has been processed and completed.
    /// @param user The address of the user whose redemption was processed.
    /// @param shares The number of shares that were redeemed.
    event RedeemProcessed(address indexed user, uint256 indexed shares);

    /// @notice A deposit request has been cancelled.
    /// @param user The address of the user whose deposit request was cancelled.
    /// @param amount The amount of assets that were requested for deposit.
    event DepositRequestCancelled(address indexed user, uint256 indexed amount);

    /// @notice A redemption request has been cancelled.
    /// @param user The address of the user whose redemption request was cancelled.
    /// @param shares The number of shares that were requested for redemption.
    event RedeemRequestCancelled(address indexed user, uint256 indexed shares);

    /// @notice The vault's state has been updated with new total assets.
    /// @param newTotalAssets The new total assets value for the vault.
    event VaultStateUpdated(uint256 indexed newTotalAssets);

    /// @notice The fee model has been updated.
    /// @param mode The new calculation mode.
    /// @param performanceFee The new performance fee in basis points.
    /// @param managementFee The new management fee in basis points.
    event FeeModelUpdated(uint8 indexed mode, uint16 indexed performanceFee, uint16 indexed managementFee);

    /// @notice Curator fees have been accrued for a specific epoch.
    /// @param epoch The epoch for which fees were accrued.
    /// @param feeAmount The amount of fees accrued in underlying asset units.
    /// @param pendingCuratorFees The total pending curator fees in underlying asset units.
    event CuratorFeesAccrued(uint256 indexed epoch, uint256 indexed feeAmount, uint256 indexed pendingCuratorFees);

    // ====================================
    // === Internal States Orchestrator ===
    // ====================================

    /// @notice The automation registry address has been updated.
    /// @param newAutomationRegistry The address of the new automation registry.
    event AutomationRegistryUpdated(address indexed newAutomationRegistry);

    /// @notice An internal state has been processed.
    /// @param epochCounter The current epoch counter after processing.
    event InternalStateProcessed(uint16 indexed epochCounter);

    // ================================
    // === Liquidity Orchestrator ===
    // ================================

    /// @notice The portfolio has been rebalanced.
    event PortfolioRebalanced();

    /// @notice A price adapter has been set for an asset.
    /// @param asset The address of the asset.
    /// @param adapter The address of the price adapter.
    event PriceAdapterSet(address indexed asset, address indexed adapter);

    /// @notice An execution adapter has been set for an asset.
    /// @param asset The address of the asset.
    /// @param adapter The address of the execution adapter.
    event ExecutionAdapterSet(address indexed asset, address indexed adapter);

    /// @notice Enumeration of available vault types.
    enum VaultType {
        Transparent,
        Encrypted
    }

    /// @notice A new Orion Vault has been created.
    /// @param vault The address of the newly created vault.
    /// @param vaultOwner The address of the vault's owner.
    /// @param curator The address of the vault's curator.
    /// @param vaultType The type of vault that was created (Transparent or Encrypted).
    event OrionVaultCreated(
        address indexed vault,
        address indexed vaultOwner,
        address indexed curator,
        VaultType vaultType
    );
}
