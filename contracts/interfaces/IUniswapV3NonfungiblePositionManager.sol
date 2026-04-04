// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.28;

/* solhint-disable use-natspec */

/**
 * @title IUniswapV3NonfungiblePositionManager
 * @notice Minimal interface for the Uniswap V3 NonfungiblePositionManager.
 * @author Orion Finance
 * @dev Declares only the functions used by this protocol.
 *      The full Uniswap v3-periphery INonfungiblePositionManager imports OZ v4 ERC721 files that
 *      are not present in OZ v5; this local subset avoids that dependency conflict.
 * @custom:security-contact security@orionfinance.ai
 */
interface IUniswapV3NonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    /// @notice Returns position details for a given token ID
    function positions(
        uint256 tokenId
    )
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );

    /// @notice Creates a new position wrapped in a NFT
    function mint(
        MintParams calldata params
    ) external returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    /// @notice Increases the amount of liquidity in a position
    function increaseLiquidity(
        IncreaseLiquidityParams calldata params
    ) external returns (uint128 liquidity, uint256 amount0, uint256 amount1);

    /// @notice Decreases the amount of liquidity in a position
    function decreaseLiquidity(
        DecreaseLiquidityParams calldata params
    ) external returns (uint256 amount0, uint256 amount1);

    /// @notice Collects up to a maximum amount of fees owed to a specific position
    function collect(CollectParams calldata params) external returns (uint256 amount0, uint256 amount1);

    /// @notice Burns a token ID (position must have 0 liquidity and all tokens collected first)
    function burn(uint256 tokenId) external;
}
