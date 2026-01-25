// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @title EventsLib
/// @notice Centralized library of events emitted throughout the Orion protocol.
/// @author Orion Finance
/// @custom:security-contact security@orionfinance.ai
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
    /// @param feeType The new fee type.
    /// @param performanceFee The new performance fee.
    /// @param managementFee The new management fee.
    /// @param newFeeRatesTimestamp The timestamp when the new fee rates become effective.
    event VaultFeeChangeScheduled(
        uint8 indexed feeType,
        uint16 indexed performanceFee,
        uint16 indexed managementFee,
        uint256 newFeeRatesTimestamp
    );

    /// @notice A protocol fee change has been scheduled.
    /// @param vFeeCoefficient The new volume fee coefficient.
    /// @param rsFeeCoefficient The new revenue share fee coefficient.
    /// @param newProtocolFeeRatesTimestamp The timestamp when the new protocol fee rates become effective.
    event ProtocolFeeChangeScheduled(
        uint16 indexed vFeeCoefficient,
        uint16 indexed rsFeeCoefficient,
        uint256 indexed newProtocolFeeRatesTimestamp
    );

    /// @notice The guardian address has been updated.
    /// @param guardian The new guardian address.
    event GuardianUpdated(address indexed guardian);

    /// @notice The protocol has been paused.
    /// @param pauser The address that triggered the pause.
    event ProtocolPaused(address indexed pauser);

    /// @notice The protocol has been unpaused.
    /// @param unpauser The address that triggered the unpause.
    event ProtocolUnpaused(address indexed unpauser);

    /// @notice A manager has been added to the whitelist.
    /// @param manager The address of the manager that was added.
    event ManagerAdded(address indexed manager);

    /// @notice A manager has been removed from the whitelist.
    /// @param manager The address of the manager that was removed.
    event ManagerRemoved(address indexed manager);

    // =======================
    // === Vault Lifecycle ===
    // =======================

    /// @notice A new order has been submitted.
    /// @param strategist The address of the strategist who submitted the order.
    /// @param assets Array of token addresses in the order.
    /// @param weights Array of weights in the order (parallel to assets array).
    event OrderSubmitted(address indexed strategist, address[] assets, uint256[] weights);

    /// @notice The vault's state has been updated with complete portfolio information.
    /// @param newTotalAssets The new total assets value for the vault.
    /// @param totalSupply The total supply of the vault.
    /// @param currentSharePrice The current share price of the vault.
    /// @param highWaterMark The new high watermark value for the vault.
    /// @param tokens Array of token addresses in the portfolio.
    /// @param shares Array of shares per asset (parallel to tokens array).
    event VaultStateUpdated(
        uint256 indexed newTotalAssets,
        uint256 indexed totalSupply,
        uint256 indexed currentSharePrice,
        uint256 highWaterMark,
        address[] tokens,
        uint256[] shares
    );

    // ================================
    // === Liquidity Orchestrator ===
    // ================================

    /// @notice The automation registry address has been updated.
    /// @param newAutomationRegistry The address of the new automation registry.
    event AutomationRegistryUpdated(address indexed newAutomationRegistry);

    /// @notice The SP1 verifier contract address has been updated.
    /// @param newVerifier The address of the new SP1 verifier contract.
    event SP1VerifierUpdated(address indexed newVerifier);

    /// @notice The internal state orchestrator verification key has been updated.
    /// @param vKey The new verification key.
    event VKeyUpdated(bytes32 indexed vKey);

    /// @notice A new epoch has started.
    /// @param epochCounter The current epoch counter.
    /// @param assets Array of asset addresses.
    /// @param prices Array of asset prices (parallel to assets array).
    event EpochStart(uint256 indexed epochCounter, address[] assets, uint256[] prices);

    /// @notice The portfolio has been rebalanced.
    /// @param epochCounter The current epoch counter.
    event EpochEnd(uint256 indexed epochCounter);

    /// @notice A price adapter has been set for an asset.
    /// @param asset The address of the asset.
    /// @param adapter The address of the price adapter.
    event PriceAdapterSet(address indexed asset, address indexed adapter);

    /// @notice An execution adapter has been set for an asset.
    /// @param asset The address of the asset.
    /// @param adapter The address of the execution adapter.
    event ExecutionAdapterSet(address indexed asset, address indexed adapter);

    /// @notice Protocol fees have been claimed.
    /// @param amount The amount of protocol fees claimed.
    event ProtocolFeesClaimed(uint256 indexed amount);

    /// @notice Liquidity has been deposited to the protocol buffer.
    /// @param depositor The address of the depositor.
    /// @param amount The amount of liquidity deposited.
    event LiquidityDeposited(address indexed depositor, uint256 amount);

    /// @notice Liquidity has been withdrawn from the protocol buffer.
    /// @param withdrawer The address of the withdrawer.
    /// @param amount The amount of liquidity withdrawn.
    event LiquidityWithdrawn(address indexed withdrawer, uint256 amount);

    /// @notice Enumeration of available vault types.
    enum VaultType {
        Transparent,
        Encrypted
    }

    /// @notice A new Orion Vault has been created.
    /// @param vault The address of the newly created vault.
    /// @param manager The address of the vault's manager.
    /// @param strategist The address of the vault's strategist.
    /// @param name The name of the vault.
    /// @param symbol The symbol of the vault.
    /// @param feeType The fee type of the vault.
    /// @param performanceFee The performance fee of the vault.
    /// @param managementFee The management fee of the vault.
    /// @param depositAccessControl The address of the deposit access control contract (address(0) = permissionless).
    /// @param vaultType The type of vault that was created (Transparent or Encrypted).
    event OrionVaultCreated(
        address indexed vault,
        address indexed manager,
        address indexed strategist,
        string name,
        string symbol,
        uint8 feeType,
        uint16 performanceFee,
        uint16 managementFee,
        address depositAccessControl,
        VaultType vaultType
    );

    /// @notice Decommissioning process for a vault has been initiated.
    /// @param vault The address of the vault being decommissioned.
    event VaultDecommissioningInitiated(address indexed vault);

    /// @notice An Orion Vault has been decommissioned.
    /// @param vault The address of the decommissioned vault.
    event OrionVaultDecommissioned(address indexed vault);

    /// @notice The vault beacon has been updated.
    /// @param newBeacon The address of the new vault beacon.
    event VaultBeaconUpdated(address indexed newBeacon);
}
