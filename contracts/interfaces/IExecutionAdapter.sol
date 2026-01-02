// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/**
 * @title IExecutionAdapter
 * @notice Interface for execution adapters that handle asset trading operations
 * @author Orion Finance
 * @dev Execution adapters are responsible for converting between the Orion protocol's underlying token
 *      and various asset types (ERC-4626 vaults, ERC-20 tokens, etc.). All buy/sell operations use
 *      the Orion underlying token as the base currency, regardless of the token standard of the target asset.
 *      The underlying token is defined in the OrionConfig contract and serves as the protocol's base asset.
 * @custom:security-contact security@orionfinance.ai
 */
interface IExecutionAdapter {
    /// @notice Validates that the given asset is compatible with this adapter
    /// @param asset The address of the asset to validate
    function validateExecutionAdapter(address asset) external view;

    /// @notice Executes a sell operation by converting asset shares to underlying assets
    /// @param asset The address of the asset to sell
    /// @param sharesAmount The amount of shares to sell
    /// @param estimatedUnderlyingAmount The estimated underlying amount to receive
    /// @return executionUnderlyingAmount The actual execution underlying amount received
    function sell(
        address asset,
        uint256 sharesAmount,
        uint256 estimatedUnderlyingAmount
    ) external returns (uint256 executionUnderlyingAmount);

    /// @notice Executes a buy operation by converting underlying assets to asset shares
    /// @param asset The address of the asset to buy
    /// @param sharesAmount The amount of shares to buy
    /// @param estimatedUnderlyingAmount The estimated underlying amount to spend
    /// @return executionUnderlyingAmount The actual execution underlying amount spent
    function buy(
        address asset,
        uint256 sharesAmount,
        uint256 estimatedUnderlyingAmount
    ) external returns (uint256 executionUnderlyingAmount);
}

/**
 * @title IExecutionAdapterWithRouting
 * @notice Extended execution adapter interface for cross-asset execution with routing parameters
 * @author Orion Finance
 * @dev Used by adapters that need to specify swap routes (e.g., OrionCrossAssetERC4626ExecutionAdapter)
 * @custom:security-contact security@orionfinance.ai
 */
interface IExecutionAdapterWithRouting is IExecutionAdapter {
    /// @notice Executes a sell operation with routing parameters
    /// @param asset The address of the asset to sell
    /// @param sharesAmount The amount of shares to sell
    /// @param estimatedUnderlyingAmount The estimated underlying amount to receive
    /// @param routeParams Venue-specific routing parameters (abi-encoded)
    /// @return executionUnderlyingAmount The actual execution underlying amount received
    function sell(
        address asset,
        uint256 sharesAmount,
        uint256 estimatedUnderlyingAmount,
        bytes calldata routeParams
    ) external returns (uint256 executionUnderlyingAmount);

    /// @notice Executes a buy operation with routing parameters
    /// @param asset The address of the asset to buy
    /// @param sharesAmount The amount of shares to buy
    /// @param estimatedUnderlyingAmount The estimated underlying amount to spend
    /// @param routeParams Venue-specific routing parameters (abi-encoded)
    /// @return executionUnderlyingAmount The actual execution underlying amount spent
    function buy(
        address asset,
        uint256 sharesAmount,
        uint256 estimatedUnderlyingAmount,
        bytes calldata routeParams
    ) external returns (uint256 executionUnderlyingAmount);
}
