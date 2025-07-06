// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

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
    event DepositRequestCancelled(address indexed user, uint256 amount, uint256 depositorCount);
    event VaultStateUpdated(uint256 newTotalAssets);

    // Internal States Orchestrator Events
    event InternalStateProcessed(uint256 epochCounter);
    event AutomationRegistryUpdated(address indexed newAutomationRegistry);

    // Liquidity Orchestrator Events
    event PortfolioRebalanced();

    // Oracle Registry Events
    event AdapterSet(address indexed asset, address indexed adapter);

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
