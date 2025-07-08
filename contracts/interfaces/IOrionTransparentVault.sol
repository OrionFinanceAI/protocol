// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "./IOrionVault.sol";

/// @title IOrionTransparentVault
/// @notice Extends the Orion Vault with plaintext portfolio intent submission and plaintextportfolio querying.
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
    /// @param order Position structs array containing the tokens and plaintext weights.
    function submitIntent(Position[] calldata order) external;

    /// @notice Returns the current portfolio (w_0).
    function getPortfolio() external view returns (address[] memory tokens, uint256[] memory sharesPerAsset);

    /// @notice Returns the current portfolio intent (w_1).
    function getIntent() external view returns (address[] memory tokens, uint256[] memory weights);

    /// @notice Updates the vault's portfolio state and total assets
    /// @dev Can only be called by the liquidity orchestrator. Clears the previous portfolio and replaces it with the new one.
    /// @param portfolio Array of Position structs containing the new portfolio token addresses and plaintext number of shares per asset.
    /// @param newTotalAssets The new total assets value for the vault
    function updateVaultState(Position[] calldata portfolio, uint256 newTotalAssets) external;
}
