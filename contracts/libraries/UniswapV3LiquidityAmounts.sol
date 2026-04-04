// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

/* solhint-disable use-natspec, gas-strict-inequalities, gas-custom-errors */

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title UniswapV3LiquidityAmounts
 * @notice Port of Uniswap v3-periphery LiquidityAmounts formulas using OpenZeppelin {Math.mulDiv}
 *         for 512-bit multiply-divide (same algorithm family as v3-core FullMath).
 * @author Orion Finance
 * @dev We cannot import periphery LiquidityAmounts.sol directly: it pulls FullMath with pragma <0.8.0,
 *      which Hardhat rejects in the same graph as ^0.8.28 contracts. See OZ Math.mulDiv for provenance.
 * @custom:security-contact security@orionfinance.ai
 */
library UniswapV3LiquidityAmounts {
    // -------------------------------------------------------------------------
    // LiquidityAmounts — same formulas as v3-periphery; mulDiv via OZ Math
    // -------------------------------------------------------------------------

    /// @notice Computes the amount of token0 for a given amount of liquidity and a price range
    function getAmount0ForLiquidity(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint128 liquidity
    ) internal pure returns (uint256 amount0) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);

        return Math.mulDiv(uint256(liquidity) << 96, sqrtRatioBX96 - sqrtRatioAX96, sqrtRatioBX96) / sqrtRatioAX96;
    }

    /// @notice Computes the amount of token1 for a given amount of liquidity and a price range
    function getAmount1ForLiquidity(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint128 liquidity
    ) internal pure returns (uint256 amount1) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);

        return Math.mulDiv(liquidity, sqrtRatioBX96 - sqrtRatioAX96, 0x1000000000000000000000000);
    }

    /// @notice Computes the token0 and token1 amounts for a given amount of liquidity, the current
    ///         pool prices, and the position's price range
    function getAmountsForLiquidity(
        uint160 sqrtRatioX96,
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint128 liquidity
    ) internal pure returns (uint256 amount0, uint256 amount1) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);

        if (sqrtRatioX96 <= sqrtRatioAX96) {
            amount0 = getAmount0ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity);
        } else if (sqrtRatioX96 < sqrtRatioBX96) {
            amount0 = getAmount0ForLiquidity(sqrtRatioX96, sqrtRatioBX96, liquidity);
            amount1 = getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioX96, liquidity);
        } else {
            amount1 = getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity);
        }
    }

    /// @notice Computes the maximum amount of liquidity received for a given amount of token0,
    ///         token1, the current pool prices, and the prices at the tick boundaries
    function getLiquidityForAmounts(
        uint160 sqrtRatioX96,
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint256 amount0,
        uint256 amount1
    ) internal pure returns (uint128 liquidity) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);

        if (sqrtRatioX96 <= sqrtRatioAX96) {
            liquidity = _getLiquidityForAmount0(sqrtRatioAX96, sqrtRatioBX96, amount0);
        } else if (sqrtRatioX96 < sqrtRatioBX96) {
            uint128 liquidity0 = _getLiquidityForAmount0(sqrtRatioX96, sqrtRatioBX96, amount0);
            uint128 liquidity1 = _getLiquidityForAmount1(sqrtRatioAX96, sqrtRatioX96, amount1);

            liquidity = liquidity0 < liquidity1 ? liquidity0 : liquidity1;
        } else {
            liquidity = _getLiquidityForAmount1(sqrtRatioAX96, sqrtRatioBX96, amount1);
        }
    }

    function _getLiquidityForAmount0(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint256 amount0
    ) private pure returns (uint128 liquidity) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        uint256 intermediate = Math.mulDiv(sqrtRatioAX96, sqrtRatioAX96, 0x1000000000000000000000000);
        return toUint128(Math.mulDiv(amount0, intermediate, sqrtRatioBX96 - sqrtRatioAX96));
    }

    function _getLiquidityForAmount1(
        uint160 sqrtRatioAX96,
        uint160 sqrtRatioBX96,
        uint256 amount1
    ) private pure returns (uint128 liquidity) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        return toUint128(Math.mulDiv(amount1, 0x1000000000000000000000000, sqrtRatioBX96 - sqrtRatioAX96));
    }

    function toUint128(uint256 x) private pure returns (uint128 y) {
        require((y = uint128(x)) == x);
    }
}
