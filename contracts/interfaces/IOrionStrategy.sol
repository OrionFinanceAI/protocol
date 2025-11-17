// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "./IOrionTransparentVault.sol";

/// @title IOrionStrategy
/// @notice Interface for passive curators that compute portfolio intents on-demand
/// @author Orion Finance
/// @dev Passive curators are smart contracts that implement this interface to provide
///      dynamic portfolio allocation strategies.
interface IOrionStrategy {
    /// @notice Compute the current portfolio intent based on market conditions and strategy.
    /// @param vault The vault to submit the intent to
    function submitIntent(IOrionTransparentVault vault) external;
}
