// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "./IOrionTransparentVault.sol";

/// @title IOrionStrategy
/// @notice Interface for manager strategies that compute portfolio intents on-demand
/// @author Orion Finance
/// @dev Manager strategies are smart contracts that implement this interface to provide
///      dynamic portfolio allocation strategies.
/// @custom:security-contact security@orionfinance.ai
interface IOrionStrategy {
    /// @notice Submit the current portfolio intent based on market conditions and strategy.
    /// @param vault The vault to submit the intent to
    function submitIntent(IOrionTransparentVault vault) external;
}
