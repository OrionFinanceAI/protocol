// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { ISwapExecutor } from "../../interfaces/ISwapExecutor.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ErrorsLib } from "../../libraries/ErrorsLib.sol";

/**
 * @title ICurvePool
 * @notice Interface for Curve Finance pool contracts
 * @author Orion Finance
 * @dev Uses Curve's native naming conventions (snake_case)
 */
// solhint-disable func-name-mixedcase, var-name-mixedcase, use-natspec
interface ICurvePool {
    /// @notice Exchange tokens in the pool
    /// @param i Index of input token
    /// @param j Index of output token
    /// @param dx Amount of input token
    /// @param min_dy Minimum amount of output token
    /// @return Amount of output token received
    function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256);

    /// @notice Exchange underlying tokens in the pool
    /// @param i Index of input token
    /// @param j Index of output token
    /// @param dx Amount of input token
    /// @param min_dy Minimum amount of output token
    /// @return Amount of output token received
    function exchange_underlying(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256);

    /// @notice Get expected output amount
    /// @param i Index of input token
    /// @param j Index of output token
    /// @param dx Amount of input token
    /// @return Expected output amount
    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);

    /// @notice Get expected output amount for underlying tokens
    /// @param i Index of input token
    /// @param j Index of output token
    /// @param dx Amount of input token
    /// @return Expected output amount
    function get_dy_underlying(int128 i, int128 j, uint256 dx) external view returns (uint256);
}

/**
 * @title CurveSwapExecutor
 * @notice Executes token swaps via Curve Finance pools
 * @author Orion Finance
 * @dev Primarily optimized for stablecoin swaps (USDC/USDT/DAI)
 *
 * Route Parameters Format (abi.encode):
 * - address pool: Curve pool address
 * - int128 i: Index of input token in pool
 * - int128 j: Index of output token in pool
 * - bool useUnderlying: Whether to use exchange_underlying (for wrapped tokens)
 *
 * Note on exact-output:
 * Curve doesn't natively support exact-output swaps. For stablecoins,
 * we approximate using 1:1 + small buffer, then refund excess.
 * For volatile pairs, this executor may be less accurate.
 *
 * Security:
 * - Respects min_dy limits set by caller
 * - All approvals are transient and zeroed after use
 * - Refunds excess output tokens to caller
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract CurveSwapExecutor is ISwapExecutor {
    using SafeERC20 for IERC20;

    /// @notice Buffer for exact-output approximation (0.2% = 20 bps)
    uint256 public constant EXACT_OUTPUT_BUFFER = 20;
    /// @notice Basis points denominator for percentage calculations
    uint256 public constant BASIS_POINTS = 10000;

    /// @inheritdoc ISwapExecutor
    /// @param tokenIn Address of the input token
    /// @param tokenOut Address of the output token
    /// @param amountOut Exact amount of output tokens desired
    /// @param amountInMax Maximum amount of input tokens to spend
    /// @param routeParams Encoded Curve pool parameters (pool, i, j, useUnderlying)
    /// @return amountIn Actual amount of input tokens spent
    function swapExactOutput(
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 amountInMax,
        bytes calldata routeParams
    ) external returns (uint256 amountIn) {
        (address pool, int128 i, int128 j, bool useUnderlying) = abi.decode(
            routeParams,
            (address, int128, int128, bool)
        );

        // Estimate input needed (1:1 + buffer for stablecoins)
        amountIn = (amountOut * (BASIS_POINTS + EXACT_OUTPUT_BUFFER)) / BASIS_POINTS;
        if (amountIn > amountInMax) {
            amountIn = amountInMax;
        }

        // Pull and approve
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(pool, amountIn);

        // Execute swap
        uint256 receivedOut = useUnderlying
            ? ICurvePool(pool).exchange_underlying(i, j, amountIn, amountOut)
            : ICurvePool(pool).exchange(i, j, amountIn, amountOut);

        // Clean up approval
        IERC20(tokenIn).forceApprove(pool, 0);

        // Verify output
        if (receivedOut < amountOut) {
            revert ErrorsLib.InsufficientSwapOutput(receivedOut, amountOut);
        }

        // Transfer exact output + any excess
        IERC20(tokenOut).safeTransfer(msg.sender, receivedOut);

        // Refund unused input
        uint256 balance = IERC20(tokenIn).balanceOf(address(this));
        if (balance > 0) {
            IERC20(tokenIn).safeTransfer(msg.sender, balance);
            amountIn -= balance;
        }
    }

    /// @inheritdoc ISwapExecutor
    /// @param tokenIn Address of the input token
    /// @param tokenOut Address of the output token
    /// @param amountIn Exact amount of input tokens to spend
    /// @param amountOutMin Minimum amount of output tokens to receive
    /// @param routeParams Encoded Curve pool parameters (pool, i, j, useUnderlying)
    /// @return amountOut Actual amount of output tokens received
    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata routeParams
    ) external returns (uint256 amountOut) {
        // Decode route parameters
        (address pool, int128 i, int128 j, bool useUnderlying) = abi.decode(
            routeParams,
            (address, int128, int128, bool)
        );

        ICurvePool curvePool = ICurvePool(pool);

        // Pull tokenIn from caller
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Approve pool to spend tokenIn
        IERC20(tokenIn).forceApprove(pool, amountIn);

        // Execute swap
        if (useUnderlying) {
            amountOut = curvePool.exchange_underlying(i, j, amountIn, amountOutMin);
        } else {
            amountOut = curvePool.exchange(i, j, amountIn, amountOutMin);
        }

        // Clean up approval
        IERC20(tokenIn).forceApprove(pool, 0);

        // Send all output to caller
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);

        // Verify minimum output was met (pool should revert, but double-check)
        if (amountOut < amountOutMin) {
            revert ErrorsLib.InsufficientSwapOutput(amountOut, amountOutMin);
        }
    }
}
