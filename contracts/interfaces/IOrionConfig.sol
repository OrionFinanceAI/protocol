// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../libraries/EventsLib.sol";

/// @title IOrionConfig
interface IOrionConfig {
    /// @notice Returns the address of the internal states orchestrator contract
    /// @dev This orchestrator manages the internal state transitions of the protocol
    /// @return The address of the internal states orchestrator
    function internalStatesOrchestrator() external view returns (address);

    /// @notice Returns the address of the liquidity orchestrator contract
    /// @dev This orchestrator manages liquidity operations and coordination
    /// @return The address of the liquidity orchestrator
    function liquidityOrchestrator() external view returns (address);

    /// @notice Returns the number of decimal places used for curator intent calculations
    /// @dev This value is used to scale curator intent values for precision
    /// @return The number of decimal places for curator intents
    function curatorIntentDecimals() external view returns (uint8);

    /// @notice Returns the address of the underlying asset used by the protocol
    /// @dev This is the base asset that the protocol operates with
    /// @return The address of the underlying asset contract
    function underlyingAsset() external view returns (IERC20);

    /// @notice Returns the address of the price adapter registry contract
    /// @dev This registry is responsible for managing asset price adapters
    /// @return The address of the price adapter registry
    function priceAdapterRegistry() external view returns (address);

    /// @notice Returns the number of decimal places used for price adapters
    /// @dev This value is used to scale price adapter values for precision
    /// @return The number of decimal places for price adapters
    function priceAdapterDecimals() external view returns (uint8);

    /// @notice Sets the underlying asset for the protocol
    /// @dev Can only be called by the contract owner
    /// @param asset The address of the underlying asset contract
    function setUnderlyingAsset(address asset) external;

    /// @notice Sets the internal states orchestrator for the protocol
    /// @dev Can only be called by the contract owner
    /// @param orchestrator The address of the internal states orchestrator
    function setInternalStatesOrchestrator(address orchestrator) external;

    /// @notice Sets the liquidity orchestrator for the protocol
    /// @dev Can only be called by the contract owner
    /// @param orchestrator The address of the liquidity orchestrator
    function setLiquidityOrchestrator(address orchestrator) external;

    /// @notice Sets the vault factories for the protocol
    /// @dev Can only be called by the contract owner
    /// @param transparentFactory The address of the transparent vault factory
    /// @param encryptedFactory The address of the encrypted vault factory
    function setVaultFactories(address transparentFactory, address encryptedFactory) external;

    /// @notice Sets the price adapter registry for the protocol
    /// @dev Can only be called by the contract owner
    /// @param registry The address of the price adapter registry
    function setPriceAdapterRegistry(address registry) external;

    /// @notice Sets the core protocol parameters in a single transaction
    /// @dev Can only be called by the contract owner
    /// @param _curatorIntentDecimals The number of decimal places for curator intents
    /// @param _priceAdapterDecimals The number of decimal places for price adapters
    function setProtocolParams(uint8 _curatorIntentDecimals, uint8 _priceAdapterDecimals) external;

    /// @notice Adds an asset to the whitelist
    /// @dev Can only be called by the contract owner
    /// @param asset The address of the asset to whitelist
    /// @param priceAdapter The address of the price adapter
    /// @param executionAdapter The address of the execution adapter
    function addWhitelistedAsset(address asset, address priceAdapter, address executionAdapter) external;

    /// @notice Removes an asset from the whitelist
    /// @dev Can only be called by the contract owner
    /// @param asset The address of the asset to remove from whitelist
    function removeWhitelistedAsset(address asset) external;

    /// @notice Returns the total number of whitelisted assets
    /// @return The count of whitelisted assets
    function whitelistedAssetsLength() external view returns (uint16);

    /// @notice Returns the whitelisted asset address at the specified index
    /// @dev Uses EnumerableSet ordering, which may change when assets are added/removed
    /// @param index The index of the asset to retrieve
    /// @return The address of the whitelisted asset at the given index
    function getWhitelistedAssetAt(uint16 index) external view returns (address);

    /// @notice Returns all whitelisted assets
    /// @return An array of whitelisted asset addresses
    function getAllWhitelistedAssets() external view returns (address[] memory);

    /// @notice Checks if an asset is whitelisted
    /// @param asset The address of the asset to check
    /// @return True if the asset is whitelisted, false otherwise
    function isWhitelisted(address asset) external view returns (bool);

    /// @notice Adds a new Orion vault to the protocol registry
    /// @dev Only callable by the vault factories contracts
    /// @param vault The address of the vault to add to the registry
    /// @param vaultType Whether the vault is encrypted or transparent
    function addOrionVault(address vault, EventsLib.VaultType vaultType) external;

    /// @notice Deregisters an Orion vault from the protocol's registry
    /// @dev Callable exclusively by the contract owner. This action does not destroy the vault itself;
    /// @dev it merely disconnects the vault from the protocol, which causes the share price to stale
    /// @dev and renders curator intents inactive.
    /// @param vault The address of the vault to be removed from the registry
    /// @param vaultType The type of the vault—either encrypted or transparent
    function removeOrionVault(address vault, EventsLib.VaultType vaultType) external;

    /// @notice Returns all Orion vault addresses
    /// @param vaultType Whether to return encrypted or transparent vaults
    /// @return An array of Orion vault addresses
    function getAllOrionVaults(EventsLib.VaultType vaultType) external view returns (address[] memory);

    /// @notice Checks if an address is a registered Orion vault
    /// @dev This function checks both encrypted and transparent vaults
    /// @param vault The address of the vault to check
    /// @return True if the address is a registered Orion vault, false otherwise
    function isOrionVault(address vault) external view returns (bool);

    /// @notice Checks if the system is idle
    /// @dev This function checks if both the liquidity orchestrator and the internal states orchestrator are idle
    /// @return True if the system is idle, false otherwise
    function isSystemIdle() external view returns (bool);
}
