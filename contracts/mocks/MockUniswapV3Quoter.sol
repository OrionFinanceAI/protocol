// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @title MockUniswapV3Quoter
/// @notice Minimal mock of IQuoterV2 for unit testing
contract MockUniswapV3Quoter {
    uint256 public nextAmountIn;

    struct QuoteExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amount;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function setNextQuoteResult(uint256 _amountIn) external {
        nextAmountIn = _amountIn;
    }

    function quoteExactOutputSingle(
        QuoteExactOutputSingleParams memory
    )
        external
        returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)
    {
        amountIn = nextAmountIn;
        sqrtPriceX96After = 0;
        initializedTicksCrossed = 0;
        gasEstimate = 0;
    }
}
