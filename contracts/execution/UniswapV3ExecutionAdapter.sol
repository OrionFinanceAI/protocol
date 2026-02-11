// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { ISwapRouter } from "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import { IExecutionAdapter } from "../interfaces/IExecutionAdapter.sol";

/**
 * @title UniswapV3ExecutionAdapter
 * @notice Executes token trades via Uniswap V3 pools
 * @author Orion Finance
 * @dev Dedicated token execution adapter for arbitrary token pairs via Uniswap V3
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract UniswapV3ExecutionAdapter is IExecutionAdapter {
    using SafeERC20 for IERC20;

    /// @notice Uniswap V3 SwapRouter contract
    ISwapRouter public immutable SWAP_ROUTER;

    /**
     * @notice Constructor
     * @param swapRouterAddress Uniswap V3 SwapRouter address
     */
    constructor(address swapRouterAddress) {
        if (swapRouterAddress == address(0)) revert ErrorsLib.ZeroAddress();
        SWAP_ROUTER = ISwapRouter(swapRouterAddress);
    }

    /// @inheritdoc ISwapExecutor
    function swapExactOutput(
        address tokenIn,
        address tokenOut,
        uint256 amountOut,
        uint256 amountInMax,
        bytes calldata routeParams
    ) external returns (uint256 amountIn) {
        // Decode fee tier from route params
        uint24 fee = abi.decode(routeParams, (uint24));

        // Pull max input from caller
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountInMax);

        // Approve router
        IERC20(tokenIn).forceApprove(address(SWAP_ROUTER), amountInMax);

        // Execute exact output swap
        ISwapRouter.ExactOutputSingleParams memory params = ISwapRouter.ExactOutputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: msg.sender,
            deadline: block.timestamp,
            amountOut: amountOut,
            amountInMaximum: amountInMax,
            sqrtPriceLimitX96: 0
        });

        amountIn = SWAP_ROUTER.exactOutputSingle(params);

        // Clean up approval
        IERC20(tokenIn).forceApprove(address(SWAP_ROUTER), 0);

        // Refund unused input
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
        // Decode fee tier from route params
        uint24 fee = abi.decode(routeParams, (uint24));

        // Pull input from caller
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Approve router
        IERC20(tokenIn).forceApprove(address(SWAP_ROUTER), amountIn);

        // Execute exact input swap
        ISwapRouter.ExactInputSingleParams memory params = ISwapRouter.ExactInputSingleParams({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            fee: fee,
            recipient: msg.sender,
            deadline: block.timestamp,
            amountIn: amountIn,
            amountOutMinimum: amountOutMin,
            sqrtPriceLimitX96: 0
        });

        amountOut = SWAP_ROUTER.exactInputSingle(params);

        // Clean up approval
        IERC20(tokenIn).forceApprove(address(SWAP_ROUTER), 0);

        // Verify minimum output (router should enforce, but double-check)
        if (amountOut < amountOutMin) {
            revert ErrorsLib.InsufficientSwapOutput(amountOut, amountOutMin);
        }
    }
}
