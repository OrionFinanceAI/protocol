// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

interface IOrionConfig {
    /// @notice Returns the address of the internal states orchestrator contract
    /// @dev This orchestrator manages the internal state transitions of the protocol
    /// @return The address of the internal states orchestrator
    function internalStatesOrchestrator() external view returns (address);

    /// @notice Returns the address of the liquidity orchestrator contract
    /// @dev This orchestrator manages liquidity operations and coordination
    /// @return The address of the liquidity orchestrator
    function liquidityOrchestrator() external view returns (address);

    /// @notice Checks if an asset is whitelisted for use in the protocol
    /// @dev Only whitelisted assets can be used in various protocol operations
    /// @param asset The address of the asset to check
    /// @return True if the asset is whitelisted, false otherwise
    function isWhitelisted(address asset) external view returns (bool);

    /// @notice Returns the number of decimal places used for curator intent calculations
    /// @dev This value is used to scale curator intent values for precision
    /// @return The number of decimal places for curator intents
    function curatorIntentDecimals() external view returns (uint8);

    /// @notice Adds a new Orion vault to the protocol registry
    /// @dev Only callable by the vault factory contract
    /// @param vault The address of the vault to add to the registry
    function addOrionVault(address vault) external;

    /// @notice Returns the address of the underlying asset used by the protocol
    /// @dev This is the base asset that the protocol operates with
    /// @return The address of the underlying asset contract
    function underlyingAsset() external view returns (address);
}
