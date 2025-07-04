// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import "./IOrionVault.sol";

/// @title IOrionTransparentVault
/// @notice Extends the Orion Vault with plaintext portfolio intent submission and plaintextportfolio querying.
interface IOrionTransparentVault is IOrionVault {
    /// @dev Struct representing a token and its desired weight in a portfolio intent.
    /// @param token The address of the ERC20 token.
    /// @param weight The desired weight of the token in the portfolio.
    ///        This value is expressed in percentage of total supply, in config.curatorIntentDecimals precision.
    struct Position {
        address token;
        uint32 weight;
    }

    /// @notice Submit a plaintext portfolio intent.
    /// @param order Position structs array containing the tokens and plaintext weights.
    function submitOrderIntent(Position[] calldata order) external;

    /// @notice Returns the current portfolio (w_0).
    function getPortfolio() external view returns (address[] memory tokens, uint256[] memory sharesPerAsset);

    // TODO: add docstring once implemented.
    function updateVaultState(Position[] calldata portfolio, uint256 newTotalAssets) external;
}
