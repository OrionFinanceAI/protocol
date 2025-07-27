// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../libraries/EventsLib.sol";

interface IOrionConfig {
    /// @notice Returns the address of the internal states orchestrator contract
    /// @dev This orchestrator manages the internal state transitions of the protocol
    /// @return The address of the internal states orchestrator
    function internalStatesOrchestrator() external view returns (address);

    /// @notice Returns the address of the liquidity orchestrator contract
    /// @dev This orchestrator manages liquidity operations and coordination
    /// @return The address of the liquidity orchestrator
    function liquidityOrchestrator() external view returns (address);

    /// @notice Returns the address of the vault factory contract
    /// @dev This factory is responsible for creating new Orion vaults
    /// @return The address of the vault factory
    function vaultFactory() external view returns (address);

    /// @notice Returns the number of decimal places used for curator intent calculations
    /// @dev This value is used to scale curator intent values for precision
    /// @return The number of decimal places for curator intents
    function curatorIntentDecimals() external view returns (uint8);

    /// @notice Returns the address of the underlying asset used by the protocol
    /// @dev This is the base asset that the protocol operates with
    /// @return The address of the underlying asset contract
    function underlyingAsset() external view returns (IERC20);

    /// @notice Returns the address of the oracle registry contract
    /// @dev This registry is responsible for managing asset price oracles
    /// @return The address of the oracle registry
    function oracleRegistry() external view returns (address);

    /// @notice Sets the core protocol parameters in a single transaction
    /// @dev Can only be called by the contract owner
    /// @param _underlyingAsset The address of the underlying asset contract
    /// @param _internalStatesOrchestrator The address of the internal states orchestrator
    /// @param _liquidityOrchestrator The address of the liquidity orchestrator
    /// @param _curatorIntentDecimals The number of decimal places for curator intents
    /// @param _factory The address of the vault factory
    /// @param _oracleRegistry The address of the oracle registry
    function setProtocolParams(
        address _underlyingAsset,
        address _internalStatesOrchestrator,
        address _liquidityOrchestrator,
        uint8 _curatorIntentDecimals,
        address _factory,
        address _oracleRegistry
    ) external;

    /// @notice Adds an asset to the whitelist
    /// @dev Can only be called by the contract owner
    /// @param asset The address of the asset to whitelist
    /// @param oracleAdapter The address of the oracle adapter
    /// @param executionAdapter The address of the execution adapter
    function addWhitelistedAsset(address asset, address oracleAdapter, address executionAdapter) external;

    /// @notice Removes an asset from the whitelist
    /// @dev Can only be called by the contract owner
    /// @param asset The address of the asset to remove from whitelist
    function removeWhitelistedAsset(address asset) external;

    /// @notice Returns the total number of whitelisted assets
    /// @return The count of whitelisted assets
    function whitelistedAssetsLength() external view returns (uint256);

    /// @notice Returns the whitelisted asset address at the specified index
    /// @dev Uses EnumerableSet ordering, which may change when assets are added/removed
    /// @param index The index of the asset to retrieve
    /// @return The address of the whitelisted asset at the given index
    function getWhitelistedAssetAt(uint256 index) external view returns (address);

    /// @notice Returns all whitelisted assets
    /// @return An array of whitelisted asset addresses
    function getAllWhitelistedAssets() external view returns (address[] memory);

    /// @notice Checks if an asset is whitelisted
    /// @param asset The address of the asset to check
    /// @return True if the asset is whitelisted, false otherwise
    function isWhitelisted(address asset) external view returns (bool);

    /// @notice Adds a new Orion vault to the protocol registry
    /// @dev Only callable by the vault factory contract
    /// @param vault The address of the vault to add to the registry
    /// @param vaultType Whether the vault is encrypted or transparent
    function addOrionVault(address vault, EventsLib.VaultType vaultType) external;

    /// @notice Removes an Orion vault from the protocol registry
    /// @dev Only callable by the vault factory contract
    /// @param vault The address of the vault to remove from the registry
    /// @param vaultType Whether the vault is encrypted or transparent
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
}
