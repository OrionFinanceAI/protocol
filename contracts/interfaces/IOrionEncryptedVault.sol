// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import "./IOrionVault.sol";

/// @title IOrionEncryptedVault
/// @notice Interface for Orion confidential vaults
/// @author Orion Finance
/// @custom:security-contact security@orionfinance.ai
interface IOrionEncryptedVault is IOrionVault {
    /// @notice Submit an encrypted portfolio intent
    /// @param intentCiphertext Opaque intent ciphertext
    function submitIntent(bytes calldata intentCiphertext) external;

    /// @notice Returns the stored portfolio ciphertext
    /// @return portfolioCiphertext Opaque portfolio
    function getPortfolio() external view returns (bytes memory portfolioCiphertext);

    /// @notice Returns the stored intent ciphertext
    /// @return intentCiphertext Opaque intent
    function getIntent() external view returns (bytes memory intentCiphertext);

    /// @notice Updates the vault's encrypted portfolio and total assets
    /// @dev Can only be called by the liquidity orchestrator.
    /// @param portfolioCiphertext Opaque portfolio
    /// @param newTotalAssets The new total assets value for the vault
    function updateVaultState(bytes calldata portfolioCiphertext, uint256 newTotalAssets) external;

    /// @notice Maximum accepted ciphertext length for the current investment universe
    /// @return Max blob length.
    function maxCiphertextLength() external view returns (uint256);
}
