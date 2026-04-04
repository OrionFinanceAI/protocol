// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IUniswapV3NonfungiblePositionManager } from "../interfaces/IUniswapV3NonfungiblePositionManager.sol";

/**
 * @title MockUniswapV3NonfungiblePositionManager
 * @notice Simplified NPM mock for unit testing UniswapV3LPWrapper share math.
 * @dev Intentional simplifications:
 *   - Liquidity returned per call is set via `setNextLiquidityReturn(uint128)`.
 *   - Used amounts equal the configured liquidity (amount0Used = amount1Used = liquidity),
 *     so token0 and token1 are always consumed 1:1 with liquidity units.
 *   - decreaseLiquidity also returns `liquidity` units of each token (same 1:1 ratio).
 *   - This keeps the share-math test invariants tractable without real tick/price math.
 *   - All tokens held by this contract are eligible for collect().
 */
contract MockUniswapV3NonfungiblePositionManager is IUniswapV3NonfungiblePositionManager {
    struct Position {
        address token0;
        address token1;
        uint128 liquidity;
        uint128 owedAmount0;
        uint128 owedAmount1;
    }

    mapping(uint256 => Position) private _positions;
    uint256 private _nextTokenId = 1;

    /// @notice Controls liquidity returned by the next mint/increaseLiquidity call
    uint128 public nextLiquidityReturn;

    function setNextLiquidityReturn(uint128 liquidity) external {
        nextLiquidityReturn = liquidity;
    }

    // ─── IUniswapV3NonfungiblePositionManager ────────────────────────────────

    function positions(
        uint256 tokenId
    )
        external
        view
        override
        returns (
            uint96,
            address,
            address token0,
            address token1,
            uint24,
            int24,
            int24,
            uint128 liquidity,
            uint256,
            uint256,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        Position storage pos = _positions[tokenId];
        return (0, address(0), pos.token0, pos.token1, 0, 0, 0, pos.liquidity, 0, 0, pos.owedAmount0, pos.owedAmount1);
    }

    function mint(
        MintParams calldata params
    ) external override returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1) {
        liquidity = nextLiquidityReturn;
        // Use exactly `liquidity` tokens of each (simplified 1:1 ratio)
        amount0 = uint256(liquidity) <= params.amount0Desired ? liquidity : params.amount0Desired;
        amount1 = uint256(liquidity) <= params.amount1Desired ? liquidity : params.amount1Desired;

        if (amount0 > 0) IERC20(params.token0).transferFrom(msg.sender, address(this), amount0);
        if (amount1 > 0) IERC20(params.token1).transferFrom(msg.sender, address(this), amount1);

        tokenId = _nextTokenId++;
        _positions[tokenId] = Position({
            token0: params.token0,
            token1: params.token1,
            liquidity: liquidity,
            owedAmount0: 0,
            owedAmount1: 0
        });
    }

    function increaseLiquidity(
        IncreaseLiquidityParams calldata params
    ) external override returns (uint128 liquidity, uint256 amount0, uint256 amount1) {
        liquidity = nextLiquidityReturn;
        Position storage pos = _positions[params.tokenId];

        amount0 = uint256(liquidity) <= params.amount0Desired ? liquidity : params.amount0Desired;
        amount1 = uint256(liquidity) <= params.amount1Desired ? liquidity : params.amount1Desired;

        if (amount0 > 0) IERC20(pos.token0).transferFrom(msg.sender, address(this), amount0);
        if (amount1 > 0) IERC20(pos.token1).transferFrom(msg.sender, address(this), amount1);

        pos.liquidity += liquidity;
    }

    function decreaseLiquidity(
        DecreaseLiquidityParams calldata params
    ) external override returns (uint256 amount0, uint256 amount1) {
        Position storage pos = _positions[params.tokenId];
        require(pos.liquidity >= params.liquidity, "MockNPM: insufficient liquidity");

        // Simplified 1:1 ratio: each liquidity unit = 1 token0 + 1 token1
        amount0 = params.liquidity;
        amount1 = params.liquidity;

        pos.liquidity -= params.liquidity;
        pos.owedAmount0 += params.liquidity;
        pos.owedAmount1 += params.liquidity;
    }

    function collect(
        CollectParams calldata params
    ) external override returns (uint256 amount0, uint256 amount1) {
        Position storage pos = _positions[params.tokenId];

        amount0 = pos.owedAmount0 < params.amount0Max ? pos.owedAmount0 : params.amount0Max;
        amount1 = pos.owedAmount1 < params.amount1Max ? pos.owedAmount1 : params.amount1Max;

        pos.owedAmount0 -= uint128(amount0);
        pos.owedAmount1 -= uint128(amount1);

        if (amount0 > 0) IERC20(pos.token0).transfer(params.recipient, amount0);
        if (amount1 > 0) IERC20(pos.token1).transfer(params.recipient, amount1);
    }

    function burn(uint256 tokenId) external override {
        delete _positions[tokenId];
    }
}
