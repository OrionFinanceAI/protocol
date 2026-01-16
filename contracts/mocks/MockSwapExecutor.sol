// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { ISwapExecutor } from "../interfaces/ISwapExecutor.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockSwapExecutor
 * @notice Mock swap executor for unit testing
 * @dev Performs 1:1 swaps without actual DEX integration
 */
contract MockSwapExecutor is ISwapExecutor {
    using SafeERC20 for IERC20;

    /// @inheritdoc ISwapExecutor
    function swapExactOutput(
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 amountInMax,
        bytes calldata /* routeParams */
    ) external returns (uint256 amountIn) {
        // Pull tokenIn from caller
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountInMax);

        // For mock, assume 1:1 swap
        amountIn = amountOut;

        // Send tokenOut to caller
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);

        // Refund unused tokenIn
        uint256 unused = amountInMax - amountIn;
        if (unused > 0) {
            IERC20(tokenIn).safeTransfer(msg.sender, unused);
        }
    }

    /// @inheritdoc ISwapExecutor
    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata /* routeParams */
    ) external returns (uint256 amountOut) {
        // Pull tokenIn from caller
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // For mock, assume 1:1 swap
        amountOut = amountIn;

        // Send tokenOut to caller
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }
}
