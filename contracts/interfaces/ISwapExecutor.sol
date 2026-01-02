// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/**
 * @title ISwapExecutor
 * @notice Interface for executing token swaps on external venues (DEXs, aggregators)
 * @author Orion Finance
 * @dev Stateless execution layer - no vault logic, no slippage logic, no oracle dependency
 *
 * Architecture:
 * - LiquidityOrchestrator → ERC4626ExecutionAdapter → SwapExecutor → DEX
 * - LO enforces slippage bounds, adapter orchestrates flow, executor only executes swaps
 * - Executor must be venue-specific but asset-agnostic via route parameters
 */
interface ISwapExecutor {
    /**
     * @notice Execute exact-output swap (guarantee exact output amount)
     * @param tokenIn Input token address
     * @param tokenOut Output token address
     * @param amountOut Exact amount of output tokens required
     * @param amountInMax Maximum input tokens allowed
     * @param routeParams Venue-specific routing parameters (abi-encoded)
     * @return amountIn Actual amount of input tokens spent
     *
     * @dev MUST revert if amountOut cannot be satisfied within amountInMax
     * @dev MUST pull tokenIn from msg.sender and send tokenOut to msg.sender
     * @dev MUST refund unused tokenIn to msg.sender
     * @dev MUST NOT implement slippage logic - limits are set by caller
     * @dev routeParams examples:
     *   - Uniswap V3: abi.encode(uint24 fee)
     *   - Curve: abi.encode(address pool, int128 i, int128 j, bool useUnderlying)
     *   - Aggregators: abi.encode(bytes swapData)
     */
    function swapExactOutput(
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 amountInMax,
        bytes calldata routeParams
    ) external returns (uint256 amountIn);

    /**
     * @notice Execute exact-input swap (swap all input, best-effort output)
     * @param tokenIn Input token address
     * @param tokenOut Output token address
     * @param amountIn Exact amount of input tokens to swap
     * @param amountOutMin Minimum output tokens required
     * @param routeParams Venue-specific routing parameters (abi-encoded)
     * @return amountOut Actual amount of output tokens received
     *
     * @dev MUST revert if amountOut < amountOutMin
     * @dev MUST pull tokenIn from msg.sender and send tokenOut to msg.sender
     * @dev MUST NOT implement slippage logic - limits are set by caller
     * @dev Used primarily in sell flow to swap all underlying received from vault
     */
    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata routeParams
    ) external returns (uint256 amountOut);
}
