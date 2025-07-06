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
    event ProtocolParamsUpdated();

    // Vault Events
    event OrderSubmitted(address indexed curator);
    event DepositRequested(address indexed user, uint256 amount);
    event WithdrawRequested(address indexed user, uint256 shares);
    event DepositProcessed(address indexed user, uint256 amount);
    event WithdrawProcessed(address indexed user, uint256 shares);
    event DepositRequestCancelled(address indexed user, uint256 amount);
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
}
