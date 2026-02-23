// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockUniswapV3Router
 * @notice Mock Uniswap V3 router for testing swap executors
 * @dev Simulates both exact-input and exact-output swaps with configurable results
 */
contract MockUniswapV3Router {
    using SafeERC20 for IERC20;

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    // Test configuration
    uint256 public nextAmountIn;
    uint256 public nextAmountOut;
    bool public shouldRevert;

    function setNextSwapResult(uint256 _amountIn, uint256 _amountOut) external {
        nextAmountIn = _amountIn;
        nextAmountOut = _amountOut;
    }

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        if (shouldRevert) revert("Mock revert");

        // Pull exact input from caller
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);

        // Return configured output
        amountOut = nextAmountOut;

        // Mint output tokens to recipient (simplified - in real router, pulls from pool)
        _mintOrTransfer(params.tokenOut, params.recipient, amountOut);

        // Check minimum output
        require(amountOut >= params.amountOutMinimum, "Insufficient output");
    }

    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn) {
        if (shouldRevert) revert("Mock revert");

        // Use configured input amount
        amountIn = nextAmountIn;

        // Check maximum input
        require(amountIn <= params.amountInMaximum, "Excessive input");

        // Pull actual input from caller
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Mint exact output tokens to recipient
        _mintOrTransfer(params.tokenOut, params.recipient, params.amountOut);
    }

    function _mintOrTransfer(address token, address to, uint256 amount) internal {
        // Try to transfer existing balance, otherwise mint
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance >= amount) {
            IERC20(token).safeTransfer(to, amount);
        } else {
            // Assume token has mint function (for testing)
            (bool success, ) = token.call(abi.encodeWithSignature("mint(address,uint256)", to, amount));
            require(success, "Mint failed");
        }
    }
}
