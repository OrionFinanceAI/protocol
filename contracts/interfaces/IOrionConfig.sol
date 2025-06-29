// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./IMarketOracle.sol";

interface IOrionConfig {
    /// @notice Returns the address of the internal states orchestrator contract
    /// @dev This orchestrator manages the internal state transitions of the protocol
    /// @return The address of the internal states orchestrator
    function internalStatesOrchestrator() external view returns (address);

    /// @notice Returns the address of the liquidity orchestrator contract
    /// @dev This orchestrator manages liquidity operations and coordination
    /// @return The address of the liquidity orchestrator
    function liquidityOrchestrator() external view returns (address);

    /// @notice Returns the address of the market oracle contract
    /// @dev This oracle provides price feeds and profit/loss calculations
    /// @return The address of the market oracle
    function marketOracle() external view returns (IMarketOracle);

    /// @notice Returns the address of the vault factory contract
    /// @dev This factory is responsible for creating new Orion vaults
    /// @return The address of the vault factory
    function vaultFactory() external view returns (address);

    /// @notice Returns the FHE public CID used for fully homomorphic encryption
    /// @dev This CID is used to reference the public parameters for FHE operations
    /// @return The FHE public CID string
    function fhePublicCID() external view returns (string memory);

    /// @notice Checks if an asset is whitelisted for use in the protocol
    /// @dev Only whitelisted assets can be used in various protocol operations
    /// @param asset The address of the asset to check
    /// @return True if the asset is whitelisted, false otherwise
    function isWhitelisted(address asset) external view returns (bool);

    /// @notice Returns the number of decimal places used for curator intent calculations
    /// @dev This value is used to scale curator intent values for precision
    /// @return The number of decimal places for curator intents
    function curatorIntentDecimals() external view returns (uint8);

    /// @notice Returns the address of the underlying asset used by the protocol
    /// @dev This is the base asset that the protocol operates with
    /// @return The address of the underlying asset contract
    function underlyingAsset() external view returns (IERC20);

    /// @notice Sets the core protocol parameters in a single transaction
    /// @dev Can only be called by the contract owner
    /// @param _underlyingAsset The address of the underlying asset contract
    /// @param _internalStatesOrchestrator The address of the internal states orchestrator
    /// @param _liquidityOrchestrator The address of the liquidity orchestrator
    /// @param _marketOracle The address of the market oracle
    /// @param _curatorIntentDecimals The number of decimal places for curator intents
    /// @param _fhePublicCID The FHE public CID string
    /// @param _factory The address of the vault factory
    function setProtocolParams(
        address _underlyingAsset,
        address _internalStatesOrchestrator,
        address _liquidityOrchestrator,
        IMarketOracle _marketOracle,
        uint8 _curatorIntentDecimals,
        string calldata _fhePublicCID,
        address _factory
    ) external;

    /// @notice Adds an asset to the whitelist
    /// @dev Can only be called by the contract owner
    /// @param asset The address of the asset to whitelist
    function addWhitelistedAsset(address asset) external;

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

    /// @notice Adds a new Orion vault to the protocol registry
    /// @dev Only callable by the vault factory contract
    /// @param vault The address of the vault to add to the registry
    function addOrionVault(address vault) external;

    /// @notice Removes an Orion vault from the protocol registry
    /// @dev Only callable by the vault factory contract
    /// @param vault The address of the vault to remove from the registry
    function removeOrionVault(address vault) external;

    /// @notice Returns all Orion vault addresses
    /// @return An array of Orion vault addresses
    function getAllOrionVaults() external view returns (address[] memory);

    /// @notice Updates the FHE public CID used for encryption operations
    /// @dev Can only be called by the contract owner
    /// @param newCID The new FHE public CID string to set
    function updateFhePublicCID(string calldata newCID) external;
}
