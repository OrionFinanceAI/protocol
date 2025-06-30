// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

/// @title EventsLib
/// @notice Library for protocol events
library EventsLib {
    // Orion Config Events
    event WhitelistedAssetAdded(address indexed asset);
    event WhitelistedAssetRemoved(address indexed asset);
    event OrionVaultAdded(address indexed vault);
    event OrionVaultRemoved(address indexed vault);
    event ProtocolParamsUpdated(
        address underlyingAsset,
        address internalStatesOrchestrator,
        address liquidityOrchestrator,
        uint8 statesDecimals,
        uint8 curatorIntentDecimals,
        address factory,
        address oracleRegistry
    );

    // Vault Events
    event OrderSubmitted(address indexed curator);
    event DepositRequested(address indexed user, uint256 amount, uint256 requestId);
    event WithdrawRequested(address indexed user, uint256 shares, uint256 requestId);
    event DepositProcessed(address indexed user, uint256 amount, uint256 requestId);
    event WithdrawProcessed(address indexed user, uint256 shares, uint256 requestId);
    event DepositRequestWithdrawn(address indexed user, uint256 amount, uint256 requestId);
    event VaultStateUpdated(uint256 newSharePrice, uint256 newTotalAssets);

    // Internal States Orchestrator Events
    /// @notice Emitted when internal states are processed
    event InternalStateProcessed(uint256 timestamp);

    /// @notice Emitted when the Chainlink Automation Registry address is updated
    event AutomationRegistryUpdated(address indexed newAutomationRegistry);

    // Oracle Registry Events
    event OracleRegistered(address indexed asset, address indexed oracle);

    // Orion Vault Factory Events
    enum VaultType {
        Transparent,
        Encrypted
    }

    event OrionVaultCreated(
        address indexed vault,
        address indexed curator,
        address indexed deployer,
        VaultType vaultType
    );

    // Liquidity Orchestrator Events
    event DepositRequestProcessed(address indexed user, uint256 amount, uint256 requestId);
    event WithdrawRequestProcessed(address indexed user, uint256 shares, uint256 requestId);
}
