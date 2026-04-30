// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.34;

import "../interfaces/IPriceAdapter.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

/**
 * @title UniswapV3PoolPriceAdapter
 * @notice Price adapter for ERC20 spot assets vs USDC using a registered Uniswap V3 pool.
 * @author Orion Finance
 *
 * @dev TWAP: pool.observe([effectiveTwapWindow, 0]), mean tick rounded like Uniswap OracleLibrary.consult, then
 *      TickMath.getSqrtRatioAtTick. If twapObserveSeconds is 0 at deploy, effectiveTwapWindow is SHORT_TWAP_SECONDS.
 *      Failed observe: allowSpotFallback uses slot0 spot (manipulable); otherwise TwapUnavailable. sqrtPriceX96==0 in
 *      slot0 reverts PoolNotInitialized (init sanity only). minPoolLiquidity checks in-range liquidity() only.
 *      minObservationCardinality lower-binds observation buffer capacity in slot0, not observation freshness, full
 *      TWAP window coverage, or liveness—use monitoring or another oracle when freshness is critical.
 *
 * @custom:security-contact security@orionfinance.ai
 */

contract UniswapV3PoolPriceAdapter is IPriceAdapter, Ownable2Step {
    using Math for uint256;

    /// @notice Observe horizon when deploy TWAP seconds are configured as zero.
    uint32 public constant SHORT_TWAP_SECONDS = 1;

    /// @notice Maximum IERC20Metadata(asset).decimals() supported for scaling.
    uint8 public constant MAX_ASSET_DECIMALS = 18;

    /// @notice Pool registered but slot0 sqrt price is zero (uninitialized).
    error PoolNotInitialized(address asset);

    /// @notice In-range pool liquidity below minPoolLiquidity.
    error LowLiquidity(address asset);

    /// @notice observe failed and spot fallback is disabled.
    error TwapUnavailable(address asset);

    /// @notice Asset decimals exceed MAX_ASSET_DECIMALS.
    error AssetDecimalsTooHigh(address asset, uint8 decimals);

    /// @notice slot0 observationCardinality below minimum (capacity gate only).
    error InsufficientObservationCardinality(address asset, uint16 cardinality, uint16 minimum);

    /// @notice TWAP window seconds is zero in pure sqrt helper.
    error ZeroTwapWindow();

    /// @notice Extra price precision digits (matches ERC4626PriceAdapter for registry normalization).
    uint8 public constant PRICE_DECIMALS = 10;

    /// @notice Protocol underlying (USDC).
    address public immutable USDC;

    /// @notice Underlying token decimals.
    uint8 public immutable USDC_DECIMALS;

    /// @notice Deploy-time TWAP horizon; zero means SHORT_TWAP_SECONDS at runtime.
    uint32 public immutable twapObserveSeconds;

    /// @notice Seconds passed to observe (resolved from deploy config).
    uint32 public immutable effectiveTwapWindow;

    /// @notice Minimum in-range liquidity(); zero skips.
    uint128 public immutable minPoolLiquidity;

    /// @notice Use slot0 spot when observe fails if true.
    bool public immutable allowSpotFallback;

    /// @notice Minimum slot0.observationCardinality (buffer size only, not freshness).
    uint16 public immutable minObservationCardinality;

    /// @notice Registered pool per priced asset (asset/USDC pool).
    mapping(address => address) public poolOf;

    /// @notice Whether USDC is token0 for the asset pool (set in setPool).
    mapping(address => bool) public usdcIsToken0ForAsset;

    /// @notice Pool registration updated for an asset.
    event PoolSet(address indexed asset, address indexed pool);

    /// @notice Constructor
    /// @param usdc Protocol underlying (USDC)
    /// @param initialOwner Ownable owner for setPool
    /// @param twapObserveSeconds_ TWAP window; 0 uses SHORT_TWAP_SECONDS as effectiveTwapWindow
    /// @param minPoolLiquidity_ Minimum in-range liquidity; 0 skips
    /// @param allowSpotFallback_ Fallback to slot0 when observe fails
    /// @param minObservationCardinality_ Minimum observation cardinality; 0 skips
    constructor(
        address usdc,
        address initialOwner,
        uint32 twapObserveSeconds_,
        uint128 minPoolLiquidity_,
        bool allowSpotFallback_,
        uint16 minObservationCardinality_
    ) Ownable(initialOwner) {
        if (usdc == address(0)) revert ErrorsLib.ZeroAddress();
        USDC = usdc;
        USDC_DECIMALS = IERC20Metadata(usdc).decimals();
        twapObserveSeconds = twapObserveSeconds_;
        effectiveTwapWindow = twapObserveSeconds_ == 0 ? SHORT_TWAP_SECONDS : twapObserveSeconds_;
        minPoolLiquidity = minPoolLiquidity_;
        allowSpotFallback = allowSpotFallback_;
        minObservationCardinality = minObservationCardinality_;
    }

    /// @notice Register or replace the V3 pool used to price an asset.
    /// @dev Pool tokens must be asset and USDC in either order.
    /// @param asset ERC20 to price (not USDC)
    /// @param pool Uniswap V3 pool address
    function setPool(address asset, address pool) external onlyOwner {
        if (asset == address(0) || pool == address(0)) revert ErrorsLib.ZeroAddress();
        if (asset == USDC) revert ErrorsLib.InvalidAdapter(asset);

        address token0 = address(0);
        address token1 = address(0);
        try IUniswapV3Pool(pool).token0() returns (address t0) {
            token0 = t0;
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }
        try IUniswapV3Pool(pool).token1() returns (address t1) {
            token1 = t1;
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }

        bool isValidPair = (token0 == asset && token1 == USDC) || (token0 == USDC && token1 == asset);
        if (!isValidPair) revert ErrorsLib.InvalidAdapter(asset);

        poolOf[asset] = pool;
        usdcIsToken0ForAsset[asset] = (token0 == USDC);
        emit PoolSet(asset, pool);
    }

    /// @inheritdoc IPriceAdapter
    function validatePriceAdapter(address asset) external view override {
        if (poolOf[asset] == address(0)) revert ErrorsLib.InvalidAdapter(asset);
    }

    /// @inheritdoc IPriceAdapter
    function getPriceData(address asset) external view override returns (uint256 price, uint8 decimals) {
        address pool = poolOf[asset];
        if (pool == address(0)) revert ErrorsLib.InvalidAdapter(asset);

        // slither-disable-next-line unused-return
        (uint160 sqrtSlot0, , , uint16 observationCardinality, , , ) = IUniswapV3Pool(pool).slot0();

        decimals = PRICE_DECIMALS + USDC_DECIMALS;
        uint8 assetDecimals = IERC20Metadata(asset).decimals();
        if (assetDecimals > MAX_ASSET_DECIMALS) {
            revert AssetDecimalsTooHigh(asset, assetDecimals);
        }
        uint256 precisionAmount = 10 ** uint256(PRICE_DECIMALS + assetDecimals);

        // Initialization sanity: not TWAP correctness; edge case could theoretically diverge from accumulators.
        if (sqrtSlot0 == 0) {
            revert PoolNotInitialized(asset);
        }

        uint16 minCard = minObservationCardinality;
        // Cardinality ≥ minCard means oracle array capacity, not recent swaps nor TWAP window coverage.
        if (minCard != 0 && observationCardinality < minCard) {
            revert InsufficientObservationCardinality(asset, observationCardinality, minCard);
        }

        // In-range liquidity only — does not bound total depth, distribution, or manipulation cost.
        uint128 minLiq = minPoolLiquidity;
        if (minLiq != 0 && IUniswapV3Pool(pool).liquidity() < minLiq) {
            revert LowLiquidity(asset);
        }

        uint32 window = effectiveTwapWindow;

        uint32[] memory secs = new uint32[](2);
        secs[0] = window;
        secs[1] = 0;

        uint160 sqrtPriceX96;
        // Try/catch on pool.observe directly — avoids external self-call gas and redundant ABI boundary.
        // Second return is required by the pool ABI but unused here (TWAP from tick cumulatives only).
        try IUniswapV3Pool(pool).observe(secs) returns (
            int56[] memory tickCumulatives,
            uint160[] memory /* secondsPerLiquidityCumulativeX128s */
        ) {
            sqrtPriceX96 = _sqrtPriceX96FromTickCumulativeDelta(tickCumulatives[1] - tickCumulatives[0], window);
        } catch {
            if (allowSpotFallback) {
                sqrtPriceX96 = sqrtSlot0;
            } else {
                revert TwapUnavailable(asset);
            }
        }

        bool usdcIsToken0 = usdcIsToken0ForAsset[asset];

        if (usdcIsToken0) {
            // rawUSDC_per_rawAsset = 2^192 / sqrtPriceX96²
            uint256 step1 = precisionAmount.mulDiv(1 << 96, sqrtPriceX96);
            price = step1.mulDiv(1 << 96, sqrtPriceX96);
        } else {
            // rawUSDC_per_rawAsset = sqrtPriceX96² / 2^192
            uint256 step1 = precisionAmount.mulDiv(sqrtPriceX96, 1 << 96);
            price = step1.mulDiv(sqrtPriceX96, 1 << 96);
        }
    }

    /// @notice Mean tick from oracle cumulative delta to sqrtPriceX96 (Q64.96).
    /// @dev Pure; rounding matches OracleLibrary.consult. Caller wraps observe in try/catch.
    function _sqrtPriceX96FromTickCumulativeDelta(
        int56 tickCumulativesDelta,
        uint32 window
    ) internal pure returns (uint160 sqrtPriceX96) {
        if (window == 0) revert ZeroTwapWindow();
        // uint32 windows fit int56; do not cast via int32 (uint32 max overflows int32).
        int56 denom = int56(uint56(window));
        int24 avgTick = int24(tickCumulativesDelta / denom);
        // Round toward negative infinity (matches Uniswap v3-periphery OracleLibrary.consult)
        if (tickCumulativesDelta < 0 && (tickCumulativesDelta % denom != 0)) {
            --avgTick;
        }
        sqrtPriceX96 = TickMath.getSqrtRatioAtTick(avgTick);
    }
}
