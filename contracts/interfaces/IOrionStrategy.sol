// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "./IOrionTransparentVault.sol";

/// @title IOrionStrategy
/// @notice Interface for passive curators that compute portfolio intents on-demand
/// @author Orion Finance
/// @dev Passive curators are smart contracts that implement this interface to provide
///      dynamic portfolio allocation strategies. The use of this is associated to a pull-based
///      and stateless implementation of vault intents.
///      The vault will call computeIntent()
///      when the InternalStatesOrchestrator needs the current intent.
interface IOrionStrategy {
    /// @notice Compute the current portfolio intent based on market conditions and strategy
    /// @param vaultWhitelistedAssets The whitelisted assets for the vault
    /// @return intent Array of Position structs containing the target allocation
    /// @dev This function should return a valid intent that sums to 100% (10^curatorIntentDecimals)
    ///      All tokens in the intent must be whitelisted for the vault
    function computeIntent(
        address[] calldata vaultWhitelistedAssets
    ) external view returns (IOrionTransparentVault.Position[] memory intent);
}
