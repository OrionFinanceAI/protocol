// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "./IOrionVault.sol";

/// @title IOrionTransparentVault
/// @notice Interface for the Orion transparent vault
/// @author Orion Finance
interface IOrionTransparentVault is IOrionVault {
    /// @dev Struct representing a token and its value in a portfolio.
    /// @param token The address of the ERC20 token.
    /// @param value The plaintext value associated with the token.
    ///        When used for portfolio intent, this represents percentage of total supply (weight).
    ///        When used for current portfolio state, this represents number of shares per asset.
    struct Position {
        address token;
        uint32 value;
    }

    /// @notice Submit a plaintext portfolio intent.
    /// @param intent Position structs array containing the tokens and plaintext weights.
    function submitIntent(Position[] calldata intent) external;

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
    /// @param portfolio Array of Position structs
    ///        It contains the new portfolio token addresses and plaintext number of shares per asset.
    /// @param newTotalAssets The new total assets value for the vault
    function updateVaultState(Position[] calldata portfolio, uint256 newTotalAssets) external;
}
