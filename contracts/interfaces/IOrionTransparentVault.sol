// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "./IOrionVault.sol";

/// @title IOrionTransparentVault
/// @notice Interface for the Orion transparent vault
/// @author Orion Finance
interface IOrionTransparentVault is IOrionVault {
    /// @dev Struct representing a token and its weight in an intent.
    /// @param token The address of the ERC20 token.
    /// @param weight The weight as percentage of total supply (uint32 for intent percentages).
    struct IntentPosition {
        address token;
        uint32 weight;
    }

    /// @dev Struct representing a token and its shares in a portfolio.
    /// @param token The address of the ERC20 token.
    /// @param shares The number of shares per asset (uint256 for portfolio shares).
    struct PortfolioPosition {
        address token;
        uint256 shares;
    }

    /// @notice Submit a plaintext portfolio intent.
    /// @param intent IntentPosition structs array containing the tokens and plaintext weights.
    function submitIntent(IntentPosition[] calldata intent) external;

    /// @notice Get the transparent portfolio.
    /// @return tokens The tokens in the portfolio.
    /// @return sharesPerAsset The shares per asset in the portfolio.
    function getPortfolio() external view returns (address[] memory tokens, uint256[] memory sharesPerAsset);

    /// @notice Get the transparent intent.
    /// @return tokens The tokens in the intent.
    /// @return weights The weights in the intent.
    function getIntent() external view returns (address[] memory tokens, uint32[] memory weights);

    /// @notice Updates the vault's portfolio state and total assets
    /// @dev Can only be called by the liquidity orchestrator.
    ///      Clears the previous portfolio and replaces it with the new one.
    /// @param portfolio Array of PortfolioPosition structs
    ///        It contains the new portfolio token addresses and plaintext number of shares per asset.
    /// @param newTotalAssets The new total assets value for the vault
    function updateVaultState(PortfolioPosition[] calldata portfolio, uint256 newTotalAssets) external;
}
