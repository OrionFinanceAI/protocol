// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IUniswapV3LPWrapper
 * @notice Interface for the ERC20 wrapper around a single Uniswap V3 LP position.
 * @author Orion Finance
 * @dev One wrapper = one fixed (token0, token1, fee, tickLower, tickUpper) position.
 *      Shares represent proportional ownership of the position's total liquidity.
 *      The execution adapter is the only entity permitted to call depositLiquidity/withdrawLiquidity.
 * @custom:security-contact security@orionfinance.ai
 */
interface IUniswapV3LPWrapper is IERC20 {
    /// @notice The Uniswap V3 pool this wrapper tracks
    /// @return pool The pool address
    function POOL() external view returns (address pool);

    /// @notice The lower-sort token of the pool pair
    /// @return token0 The token0 address
    function TOKEN0() external view returns (address token0);

    /// @notice The higher-sort token of the pool pair
    /// @return token1 The token1 address
    function TOKEN1() external view returns (address token1);

    /// @notice The pool fee tier in hundredths of a bip (e.g. 3000 = 0.3 %)
    /// @return fee The fee tier
    function FEE() external view returns (uint24 fee);

    /// @notice Lower tick of the position range
    /// @return tickLower The lower tick
    function TICK_LOWER() external view returns (int24 tickLower);

    /// @notice Upper tick of the position range
    /// @return tickUpper The upper tick
    function TICK_UPPER() external view returns (int24 tickUpper);

    /// @notice sqrt(1.0001^tickLower) * 2^96, pre-computed at deployment
    /// @return sqrtRatioLowerX96 The lower sqrt price X96
    function SQRT_RATIO_LOWER_X96() external view returns (uint160 sqrtRatioLowerX96);

    /// @notice sqrt(1.0001^tickUpper) * 2^96, pre-computed at deployment
    /// @return sqrtRatioUpperX96 The upper sqrt price X96
    function SQRT_RATIO_UPPER_X96() external view returns (uint160 sqrtRatioUpperX96);

    /// @notice The NFT token-id of the position held by this wrapper (0 = no position yet)
    /// @return id The position NFT id
    function tokenId() external view returns (uint256 id);

    /// @notice Current liquidity held in the underlying NFT position
    /// @return liquidity Total position liquidity
    function totalLiquidity() external view returns (uint128 liquidity);

    /**
     * @notice Mint or add liquidity to the position and issue wrapper shares to `recipient`.
     * @dev Only callable by the registered execution adapter.
     *      Pulls `amount0` of TOKEN0 and `amount1` of TOKEN1 from `msg.sender` via transferFrom.
     *      Any tokens NOT used by the NonfungiblePositionManager are returned to `msg.sender`.
     * @param amount0 Maximum TOKEN0 to provide
     * @param amount1 Maximum TOKEN1 to provide
     * @param recipient Address that receives the newly minted ERC20 shares
     * @param minSharesOut Minimum shares that must be minted (pass 0 to skip check — tests only;
     *        the LP execution adapter passes the LO order size so fills match epoch intent)
     * @return shares Wrapper shares minted to `recipient`
     * @return usedAmount0 Actual TOKEN0 consumed by the NFT position
     * @return usedAmount1 Actual TOKEN1 consumed by the NFT position
     */
    function depositLiquidity(
        uint256 amount0,
        uint256 amount1,
        address recipient,
        uint256 minSharesOut
    ) external returns (uint256 shares, uint256 usedAmount0, uint256 usedAmount1);

    /**
     * @notice Burn wrapper shares from `msg.sender` and withdraw proportional liquidity + fees to `recipient`.
     * @dev Only callable by the registered execution adapter.
     *      Fees accrued in the position are collected on every withdrawal and forwarded to `recipient`.
     * @param shares Wrapper shares to burn (held by the execution adapter)
     * @param recipient Address that receives TOKEN0 and TOKEN1
     * @return amount0 TOKEN0 delivered to `recipient`
     * @return amount1 TOKEN1 delivered to `recipient`
     */
    function withdrawLiquidity(uint256 shares, address recipient) external returns (uint256 amount0, uint256 amount1);
}
