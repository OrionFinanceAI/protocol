// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { ISwapExecutor } from "../../interfaces/ISwapExecutor.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ErrorsLib } from "../../libraries/ErrorsLib.sol";
import { ISwapRouter } from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";

/**
 * @title UniswapV3SwapExecutor
 * @notice Executes token swaps via Uniswap V3 router
 * @author Orion Finance
 * @dev Supports both exact-input and exact-output swaps with configurable routing
 *
 * Route Parameters Format (abi.encode):
 * - uint24 fee: Pool fee tier (500, 3000, or 10000 for 0.05%, 0.3%, or 1%)
 *
 * Security:
 * - Respects amountInMax/amountOutMin limits set by caller
 * - All approvals are transient and zeroed after use
 * - Refunds unused input tokens to caller
 * - Stateless execution (no storage variables)
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract UniswapV3SwapExecutor is ISwapExecutor {
    using SafeERC20 for IERC20;

    /// @notice Uniswap V3 swap router
    ISwapRouter public immutable swapRouter;

    /**
     * @notice Constructor
     * @param _swapRouter Uniswap V3 SwapRouter address
     */
    constructor(address _swapRouter) {
        if (_swapRouter == address(0)) revert ErrorsLib.ZeroAddress();
        swapRouter = ISwapRouter(_swapRouter);
    }
    /// @inheritdoc ISwapExecutor
    function swapExactOutput(
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 amountInMax,
        bytes calldata routeParams
    ) external returns (uint256 amountIn) {
        // Decode route parameters
        uint24 fee = abi.decode(routeParams, (uint24));

        // Pull tokenIn from caller (adapter)
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountInMax);

        // Approve router to spend tokenIn
        IERC20(tokenIn).forceApprove(address(swapRouter), amountInMax);

        // Execute exact-output swap
        ISwapRouter.ExactOutputSingleParams memory params = ISwapRouter.ExactOutputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: msg.sender, // Send output directly to adapter
            deadline: block.timestamp,
            amountOut: amountOut,
            amountInMaximum: amountInMax,
            sqrtPriceLimitX96: 0 // No price limit (amountInMax enforces bounds)
        });

        amountIn = swapRouter.exactOutputSingle(params);

        // Clean up approval
        IERC20(tokenIn).forceApprove(address(swapRouter), 0);

        // Refund unused tokenIn to caller
        uint256 unusedBalance = IERC20(tokenIn).balanceOf(address(this));
        if (unusedBalance > 0) {
            IERC20(tokenIn).safeTransfer(msg.sender, unusedBalance);
        }
    }

    /// @inheritdoc ISwapExecutor
    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata routeParams
    ) external returns (uint256 amountOut) {
        // Decode route parameters
        uint24 fee = abi.decode(routeParams, (uint24));

        // Pull tokenIn from caller (adapter)
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Approve router to spend tokenIn
        IERC20(tokenIn).forceApprove(address(swapRouter), amountIn);

        // Execute exact-input swap
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: msg.sender, // Send output directly to adapter
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0 // No price limit (amountOutMin enforces bounds)
        });

        amountOut = swapRouter.exactInputSingle(params);

        // Clean up approval
        IERC20(tokenIn).forceApprove(address(swapRouter), 0);
    }
}
