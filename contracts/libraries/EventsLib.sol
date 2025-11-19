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

    /// @notice The risk-free rate has been updated.
    /// @param riskFreeRate The new risk-free rate in basis points.
    event RiskFreeRateUpdated(uint16 indexed riskFreeRate);

    /// @notice The minimum deposit amount has been updated.
    /// @param minDepositAmount The new minimum deposit amount.
    event MinDepositAmountUpdated(uint256 indexed minDepositAmount);

    /// @notice The minimum redeem amount has been updated.
    /// @param minRedeemAmount The new minimum redeem amount.
    event MinRedeemAmountUpdated(uint256 indexed minRedeemAmount);

    /// @notice The fee change cooldown duration has been updated.
    /// @param newCooldownDuration The new cooldown duration in seconds.
    event FeeChangeCooldownDurationUpdated(uint256 indexed newCooldownDuration);

    /// @notice The maximum fulfill batch size has been updated.
    /// @param maxFulfillBatchSize The new maximum fulfill batch size.
    event MaxFulfillBatchSizeUpdated(uint256 indexed maxFulfillBatchSize);

    /// @notice A vault fee model change has been scheduled.
    /// @param vault The address of the vault.
    event VaultFeeChangeScheduled(address indexed vault);

    /// @notice A protocol fee change has been scheduled.
    /// @param vFeeCoefficient The new volume fee coefficient.
    /// @param rsFeeCoefficient The new revenue share fee coefficient.
    event ProtocolFeeChangeScheduled(uint16 vFeeCoefficient, uint16 rsFeeCoefficient);

    /// @notice The guardian address has been updated.
    /// @param guardian The new guardian address.
    event GuardianUpdated(address indexed guardian);

    /// @notice The protocol has been paused.
    /// @param pauser The address that triggered the pause.
    event ProtocolPaused(address indexed pauser);

    /// @notice The protocol has been unpaused.
    /// @param unpauser The address that triggered the unpause.
    event ProtocolUnpaused(address indexed unpauser);

    /// @notice A vault owner has been removed from the whitelist.
    /// @param vaultOwner The address of the vault owner that was removed.
    event VaultOwnerRemoved(address indexed vaultOwner);

    // =======================
    // === Vault Lifecycle ===
    // =======================

    /// @notice A new order has been submitted by a curator.
    /// @param curator The address of the curator who submitted the order.
    event OrderSubmitted(address indexed curator);

    /// @notice The vault's state has been updated with new total assets.
    /// @param newTotalAssets The new total assets value for the vault.
    event VaultStateUpdated(uint256 indexed newTotalAssets);

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
    /// @param name The name of the vault.
    /// @param symbol The symbol of the vault.
    /// @param feeType The fee type of the vault.
    /// @param performanceFee The performance fee of the vault.
    /// @param managementFee The management fee of the vault.
    /// @param vaultType The type of vault that was created (Transparent or Encrypted).
    event OrionVaultCreated(
        address indexed vault,
        address indexed vaultOwner,
        address indexed curator,
        string name,
        string symbol,
        uint8 feeType,
        uint16 performanceFee,
        uint16 managementFee,
        VaultType vaultType
    );
}
