// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "./IOrionVault.sol";

/// @title IOrionTransparentVault
/// @notice Interface for the Orion transparent vault
/// @author Orion Finance
/// @custom:security-contact security@orionfinance.ai
interface IOrionTransparentVault is IOrionVault {
    /// @dev Struct representing a token and its weight in an intent.
    /// @param token The address of the ERC20 token.
    /// @param weight The weight as percentage of total supply (uint32 for intent percentages).
    struct IntentPosition {
        address token;
        uint32 weight;
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
    ///      Updates the high watermark if the current share price exceeds it.
    ///      The system maintains a single global high watermark shared across all LPs.
    /// @param tokens Array of token addresses in the portfolio
    /// @param shares Array of shares per asset (parallel to tokens array)
    /// @param newTotalAssets The new total assets value for the vault
    function updateVaultState(address[] calldata tokens, uint256[] calldata shares, uint256 newTotalAssets) external;
}
