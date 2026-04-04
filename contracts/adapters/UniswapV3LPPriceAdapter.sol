// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IPriceAdapter } from "../interfaces/IPriceAdapter.sol";
import { IPriceAdapterRegistry } from "../interfaces/IPriceAdapterRegistry.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { IUniswapV3LPWrapper } from "../interfaces/IUniswapV3LPWrapper.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { UniswapV3LiquidityAmounts as LiquidityAmounts } from "../libraries/UniswapV3LiquidityAmounts.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title UniswapV3LPPriceAdapter
 * @notice Price adapter for UniswapV3LPWrapper shares.
 * @author Orion Finance
 *
 * @dev Pricing methodology
 * ───────────────────────
 * The price of one wrapper share is computed as:
 *
 *   1. Derive the liquidity corresponding to `precisionShares = 10^(PRICE_DECIMALS + wrapperDecimals)` shares,
 *      proportional to the total supply.
 *   2. Use LiquidityAmounts.getAmountsForLiquidity (with the live pool sqrtPriceX96 and the wrapper's
 *      fixed tick-range sqrtRatios) to compute `(amount0, amount1)` for that precision liquidity.
 *   3. Convert each token amount to protocol-underlying units using the existing IPriceAdapterRegistry.
 *   4. Return `(totalValue, PRICE_DECIMALS + UNDERLYING_ASSET_DECIMALS)` — identical to the ERC4626PriceAdapter
 *      convention so the PriceAdapterRegistry can normalize it correctly.
 *
 * Note: accumulated uncollected fees are NOT included in the valuation. They are collected on every
 *       withdrawLiquidity call and are therefore realised at that time.
 *
 * Both TOKEN0 and TOKEN1 of the LP wrapper must already be registered in the OrionConfig price registry.
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract UniswapV3LPPriceAdapter is IPriceAdapter {
    using Math for uint256;

    /// @notice Precision amplifier — mirrors ERC4626PriceAdapter
    uint8 public constant PRICE_DECIMALS = 10;

    /// @notice Orion protocol configuration contract
    IOrionConfig public immutable CONFIG;

    /// @notice Price registry used to fetch component token prices
    IPriceAdapterRegistry public immutable PRICE_REGISTRY;

    /// @notice Protocol underlying asset decimals
    uint8 public immutable UNDERLYING_ASSET_DECIMALS;

    /// @notice Uniswap V3 factory (used in validatePriceAdapter)
    IUniswapV3Factory public immutable UNISWAP_V3_FACTORY;

    /**
     * @notice Deploys the adapter with Orion config and Uniswap V3 factory.
     * @param configAddress      OrionConfig contract address
     * @param factoryAddress     Uniswap V3 Factory address
     */
    constructor(address configAddress, address factoryAddress) {
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();
        if (factoryAddress == address(0)) revert ErrorsLib.ZeroAddress();

        CONFIG = IOrionConfig(configAddress);
        PRICE_REGISTRY = IPriceAdapterRegistry(CONFIG.priceAdapterRegistry());
        UNDERLYING_ASSET_DECIMALS = IERC20Metadata(address(CONFIG.underlyingAsset())).decimals();
        UNISWAP_V3_FACTORY = IUniswapV3Factory(factoryAddress);
    }

    // ─── IPriceAdapter ────────────────────────────────────────────────────────

    /// @inheritdoc IPriceAdapter
    function validatePriceAdapter(address asset) external view override {
        IUniswapV3LPWrapper wrapper = IUniswapV3LPWrapper(asset);

        // Pool must exist on-chain
        address pool = UNISWAP_V3_FACTORY.getPool(wrapper.TOKEN0(), wrapper.TOKEN1(), wrapper.FEE());
        if (pool == address(0)) revert ErrorsLib.InvalidAdapter(asset);
        if (pool != wrapper.POOL()) revert ErrorsLib.InvalidAdapter(asset);

        // Both component tokens must be priced
        if (!CONFIG.isWhitelisted(wrapper.TOKEN0())) revert ErrorsLib.TokenNotWhitelisted(wrapper.TOKEN0());
        if (!CONFIG.isWhitelisted(wrapper.TOKEN1())) revert ErrorsLib.TokenNotWhitelisted(wrapper.TOKEN1());

        // Tick range must be valid (sqrtRatios must be ordered)
        uint160 sqrtLo = wrapper.SQRT_RATIO_LOWER_X96();
        uint160 sqrtHi = wrapper.SQRT_RATIO_UPPER_X96();
        if (sqrtLo == 0 || sqrtHi == 0) revert ErrorsLib.InvalidAdapter(asset);
        // solhint-disable-next-line gas-strict-inequalities
        if (sqrtLo >= sqrtHi) revert ErrorsLib.InvalidAdapter(asset);
    }

    /// @inheritdoc IPriceAdapter
    function getPriceData(address asset) external view override returns (uint256 price, uint8 decimals) {
        IUniswapV3LPWrapper wrapper = IUniswapV3LPWrapper(asset);

        uint8 wrapperDecimals = IERC20Metadata(asset).decimals();
        uint256 supply = wrapper.totalSupply();
        uint128 totalLiq = wrapper.totalLiquidity();

        // No shares outstanding or empty position: return zero price (registry will revert if used in epoch)
        if (supply == 0 || totalLiq == 0) {
            return (0, PRICE_DECIMALS + UNDERLYING_ASSET_DECIMALS);
        }

        // Precision shares: same pattern as ERC4626PriceAdapter
        uint256 precisionShares = 10 ** (PRICE_DECIMALS + uint256(wrapperDecimals));

        // Liquidity corresponding to `precisionShares` (must fit uint128 for Uniswap math)
        uint256 precisionLiqU256 = uint256(totalLiq).mulDiv(precisionShares, supply);
        if (precisionLiqU256 > type(uint128).max) revert ErrorsLib.LiquidityPrecisionOverflow(asset);
        uint128 precisionLiq = uint128(precisionLiqU256);

        // Live pool price
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(wrapper.POOL()).slot0();

        // Token amounts for the precision liquidity at current price
        (uint256 amount0, uint256 amount1) = LiquidityAmounts.getAmountsForLiquidity(
            sqrtPriceX96,
            wrapper.SQRT_RATIO_LOWER_X96(),
            wrapper.SQRT_RATIO_UPPER_X96(),
            precisionLiq
        );

        // Convert each token amount to protocol-underlying units (scaled via _tokenAmountToUnderlyingValue).
        // value_i = amount_i * getPrice(token_i) / 10^priceDec / 10^tokenDec * 10^underlyingDec
        uint8 priceAdapterDecimals = CONFIG.priceAdapterDecimals();
        uint256 scaleDivisor = 10 ** priceAdapterDecimals;
        uint256 underlyingScale = 10 ** uint256(UNDERLYING_ASSET_DECIMALS);

        address token0 = wrapper.TOKEN0();
        address token1 = wrapper.TOKEN1();

        uint256 value0 = _tokenAmountToUnderlyingValue(
            amount0,
            IERC20Metadata(token0).decimals(),
            PRICE_REGISTRY.getPrice(token0),
            scaleDivisor,
            underlyingScale
        );

        uint256 value1 = _tokenAmountToUnderlyingValue(
            amount1,
            IERC20Metadata(token1).decimals(),
            PRICE_REGISTRY.getPrice(token1),
            scaleDivisor,
            underlyingScale
        );

        uint256 totalValue = value0 + value1;

        // Return (value of precisionShares, PRICE_DECIMALS + underlyingDecimals) — registry normalises
        return (totalValue, PRICE_DECIMALS + UNDERLYING_ASSET_DECIMALS);
    }

    // ─── Internal helpers ─────────────────────────────────────────────────────

    /**
     * @dev Convert `tokenAmount` raw token units to protocol-underlying raw units.
     *
     *      value = tokenAmount × registryPrice × underlyingScale
     *              ─────────────────────────────────────────────
     *                      10^tokenDecimals × scaleDivisor
     *
     * where `registryPrice` is the price of one whole token (normalised to priceAdapterDecimals).
     */
    function _tokenAmountToUnderlyingValue(
        uint256 tokenAmount,
        uint8 tokenDecimals,
        uint256 registryPrice,
        uint256 scaleDivisor,
        uint256 underlyingScale
    ) internal pure returns (uint256) {
        if (tokenAmount == 0) return 0;
        uint256 tokenScale = 10 ** uint256(tokenDecimals);
        // Use two-step mulDiv to avoid intermediate overflow
        return tokenAmount.mulDiv(registryPrice, tokenScale).mulDiv(underlyingScale, scaleDivisor);
    }
}
