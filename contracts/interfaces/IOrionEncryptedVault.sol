// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { euint32 } from "@fhevm/solidity/lib/FHE.sol";

import "./IOrionVault.sol";

/// @title IOrionEncryptedVault
interface IOrionEncryptedVault is IOrionVault {
    /// @dev Struct representing a token and its value in a portfolio.
    /// @param token The address of the ERC20 token.
    /// @param value The encrypted value associated with the token.
    ///        When used for portfolio intent, this represents percentage of total supply (weight).
    ///        When used for current portfolio state, this represents number of shares per asset.
    struct EncryptedPosition {
        address token;
        euint32 value;
    }

    /// @notice Submit an encrypted portfolio intent.
    /// @param order EncryptedPosition struct containing the tokens and encrypted weights.
    /// @dev The weights are interpreted as percentage of total supply.
    function submitIntent(EncryptedPosition[] calldata order) external;

    /// @notice Returns the current encrypted portfolio (w_0)
    /// @return tokens The tokens in the portfolio.
    /// @return sharesPerAsset The shares per asset in the portfolio.
    function getPortfolio() external view returns (address[] memory tokens, euint32[] memory sharesPerAsset);

    /// @notice Get the encrypted intent.
    /// @return tokens The tokens in the intent.
    /// @return weights The weights in the intent.
    function getIntent() external view returns (address[] memory tokens, euint32[] memory weights);

    /// @notice Updates the vault's portfolio state and total assets
    /// @dev Can only be called by the liquidity orchestrator.
    ///      Clears the previous portfolio and replaces it with the new one.
    /// @param portfolio Array of EncryptedPosition structs
    ///        It contains the new portfolio token addresses and encrypted number of shares per asset.
    /// @param newTotalAssets The new total assets value for the vault
    function updateVaultState(EncryptedPosition[] calldata portfolio, uint256 newTotalAssets) external;
}
