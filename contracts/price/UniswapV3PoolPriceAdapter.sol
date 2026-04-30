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
 * @dev TWAP via pool.observe([TWAP_OBSERVE_SECONDS, 0]); tick mean matches OracleLibrary.consult rounding,
 *      then TickMath.getSqrtRatioAtTick. Failed observe reverts with TwapUnavailable.
 *      `setPool` probes the same observe horizon and enforces MIN_OBSERVATION_CARDINALITY on slot0 so registration
 *      fails before a pool is stored. Runtime cardinality is not re-checked (buffer size is not freshness).
 *      When MAX_OBSERVATION_STALENESS_SECONDS > 0, the latest oracle observation at slot0.observationIndex must be
 *      initialized and within that age vs block.timestamp at both registration and read (heuristic only).
 *      sqrtPriceX96==0 in slot0 reverts PoolNotInitialized. MIN_POOL_LIQUIDITY checks in-range liquidity() only.
 *
 * @custom:security-contact security@orionfinance.ai
 */

contract UniswapV3PoolPriceAdapter is IPriceAdapter, Ownable2Step {
    using Math for uint256;

    /// @notice Minimum allowed TWAP window to avoid effectively-spot pricing.
    uint32 public constant MIN_TWAP_WINDOW = 10;

    /// @notice Maximum IERC20Metadata(asset).decimals() supported for scaling.
    uint8 public constant MAX_ASSET_DECIMALS = 18;

    /// @notice Pool registered but slot0 sqrt price is zero (uninitialized).
    error PoolNotInitialized(address asset);

    /// @notice In-range pool liquidity below minPoolLiquidity.
    error LowLiquidity(address asset);

    /// @notice observe failed (TWAP probe at registration or price read).
    error TwapUnavailable(address asset);

    /// @notice Asset decimals exceed MAX_ASSET_DECIMALS.
    error AssetDecimalsTooHigh(address asset, uint8 decimals);

    /// @notice slot0 observationCardinality below minimum at registration (buffer capacity only).
    error InsufficientObservationCardinality(address asset, uint16 cardinality, uint16 minimum);

    /// @notice TWAP window seconds is zero in pure sqrt helper.
    error ZeroTwapWindow();

    /// @notice Mean TWAP tick is outside int24 bounds accepted by TickMath.
    error TickOutOfBounds();

    /// @notice Latest oracle observation uninitialized or slot index mismatch vs pool expectations.
    error OracleObservationNotInitialized(address asset);

    /// @notice Latest oracle observation older than MAX_OBSERVATION_STALENESS_SECONDS (when non-zero).
    error OracleStale(address asset);

    /// @notice Extra price precision digits (matches ERC4626PriceAdapter for registry normalization).
    uint8 public constant PRICE_DECIMALS = 10;

    /// @notice Protocol underlying (USDC).
    address public immutable USDC;

    /// @notice Underlying token decimals.
    uint8 public immutable USDC_DECIMALS;

    /// @notice Deploy-time TWAP horizon in seconds (must be >= MIN_TWAP_WINDOW).
    uint32 public immutable TWAP_OBSERVE_SECONDS;

    /// @notice Minimum in-range liquidity(); zero skips.
    uint128 public immutable MIN_POOL_LIQUIDITY;

    /// @notice Minimum slot0.observationCardinality enforced at registration only (buffer size, not freshness).
    uint16 public immutable MIN_OBSERVATION_CARDINALITY;

    /// @notice Max seconds since latest observation blockTimestamp; zero disables staleness check.
    uint32 public immutable MAX_OBSERVATION_STALENESS_SECONDS;

    /// @notice Registered pool per priced asset (asset/USDC pool).
    mapping(address => address) public poolOf;

    /// @notice Whether USDC is token0 for the asset pool (set in setPool).
    mapping(address => bool) public usdcIsToken0ForAsset;

    /// @notice Pool registration updated for an asset.
    /// @param asset Priced ERC20 (not USDC).
    /// @param pool Uniswap V3 pool registered for the asset.
    event PoolSet(address indexed asset, address indexed pool);

    /// @notice Constructor
    /// @param usdc Protocol underlying (USDC)
    /// @param initialOwner Ownable owner for setPool
    /// @param twapObserveSeconds_ TWAP window in seconds; must be >= MIN_TWAP_WINDOW
    /// @param minPoolLiquidity_ Minimum in-range liquidity; 0 skips
    /// @param minObservationCardinality_ Minimum observation cardinality at setPool; 0 skips
    /// @param maxObservationStalenessSeconds_ Max age of latest observation; 0 skips staleness guard
    constructor(
        address usdc,
        address initialOwner,
        uint32 twapObserveSeconds_,
        uint128 minPoolLiquidity_,
        uint16 minObservationCardinality_,
        uint32 maxObservationStalenessSeconds_
    ) Ownable(initialOwner) {
        if (usdc == address(0)) revert ErrorsLib.ZeroAddress();
        if (twapObserveSeconds_ < MIN_TWAP_WINDOW) revert ErrorsLib.InvalidArguments();
        USDC = usdc;
        USDC_DECIMALS = IERC20Metadata(usdc).decimals();
        TWAP_OBSERVE_SECONDS = twapObserveSeconds_;
        MIN_POOL_LIQUIDITY = minPoolLiquidity_;
        MIN_OBSERVATION_CARDINALITY = minObservationCardinality_;
        MAX_OBSERVATION_STALENESS_SECONDS = maxObservationStalenessSeconds_;
    }

    /// @notice Register or replace the V3 pool used to price an asset.
    /// @dev Pool tokens must be asset and USDC in either order. Probes observe TWAP horizon and staleness (if configured).
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

        IUniswapV3Pool p = IUniswapV3Pool(pool);
        // slither-disable-next-line unused-return
        (uint160 sqrtSlot0, , uint16 observationIndex, uint16 observationCardinality, , , ) = p.slot0();

        if (sqrtSlot0 == 0) {
            revert PoolNotInitialized(asset);
        }

        uint16 minCard = MIN_OBSERVATION_CARDINALITY;
        if (minCard != 0 && observationCardinality < minCard) {
            revert InsufficientObservationCardinality(asset, observationCardinality, minCard);
        }

        uint32[] memory secs = new uint32[](2);
        secs[0] = TWAP_OBSERVE_SECONDS;
        secs[1] = 0;
        // slither-disable-next-line unused-return
        try p.observe(secs) returns (int56[] memory, uint160[] memory) { }
        catch {
            revert TwapUnavailable(asset);
        }

        _validateObservationFreshness(p, asset, observationIndex);

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

        IUniswapV3Pool p = IUniswapV3Pool(pool);
        // slither-disable-next-line unused-return
        (uint160 sqrtSlot0, , uint16 observationIndex, , , , ) = p.slot0();

        decimals = PRICE_DECIMALS + USDC_DECIMALS;
        uint8 assetDecimals = IERC20Metadata(asset).decimals();
        if (assetDecimals > MAX_ASSET_DECIMALS) {
            revert AssetDecimalsTooHigh(asset, assetDecimals);
        }
        uint256 precisionAmount = 10 ** uint256(PRICE_DECIMALS + assetDecimals);

        if (sqrtSlot0 == 0) {
            revert PoolNotInitialized(asset);
        }

        _validateObservationFreshness(p, asset, observationIndex);

        uint128 minLiq = MIN_POOL_LIQUIDITY;
        if (minLiq != 0 && p.liquidity() < minLiq) {
            revert LowLiquidity(asset);
        }

        uint160 sqrtPriceX96 = _observeSqrtPriceX96(pool, asset);
        price = _priceFromSqrtX96(precisionAmount, sqrtPriceX96, usdcIsToken0ForAsset[asset]);
    }

    /// @dev Heuristic: slot0.observationIndex entry must be initialized and recent when staleness cap is set.
    function _validateObservationFreshness(
        IUniswapV3Pool pool,
        address asset,
        uint16 observationIndex
    ) internal view {
        uint32 maxStale = MAX_OBSERVATION_STALENESS_SECONDS;
        if (maxStale == 0) return;

        (uint32 blockTimestamp, , , bool initialized) = pool.observations(observationIndex);
        if (!initialized) {
            revert OracleObservationNotInitialized(asset);
        }
        if (block.timestamp > blockTimestamp && block.timestamp - blockTimestamp > uint256(maxStale)) {
            revert OracleStale(asset);
        }
    }

    /// @notice TWAP sqrt from observe.
    /// @dev Second observe return is unused (tick cumulatives only).
    function _observeSqrtPriceX96(address pool, address asset) internal view returns (uint160 sqrtPriceX96) {
        uint32 window = TWAP_OBSERVE_SECONDS;
        uint32[] memory secs = new uint32[](2);
        secs[0] = window;
        secs[1] = 0;

        // slither-disable-next-line unused-return
        try IUniswapV3Pool(pool).observe(secs) returns (
            int56[] memory tickCumulatives,
            uint160[] memory /* secondsPerLiquidityCumulativeX128s */
        ) {
            sqrtPriceX96 = _sqrtPriceX96FromTickCumulativeDelta(tickCumulatives[1] - tickCumulatives[0], window);
        } catch {
            revert TwapUnavailable(asset);
        }
    }

    /// @notice Convert sqrtPriceX96 to raw USDC per raw asset using PRICE_DECIMALS scaling.
    /// @param precisionAmount `10 ** (PRICE_DECIMALS + assetDecimals)`.
    /// @param sqrtPriceX96 Q64.96 sqrt price from TWAP.
    /// @param usdcIsToken0 Whether USDC is token0 in the pool.
    /// @return price Raw price in USDC minor units with PRICE_DECIMALS extra precision.
    function _priceFromSqrtX96(
        uint256 precisionAmount,
        uint160 sqrtPriceX96,
        bool usdcIsToken0
    ) internal pure returns (uint256 price) {
        if (usdcIsToken0) {
            uint256 step1 = precisionAmount.mulDiv(1 << 96, sqrtPriceX96);
            price = step1.mulDiv(1 << 96, sqrtPriceX96);
        } else {
            uint256 step1 = precisionAmount.mulDiv(sqrtPriceX96, 1 << 96);
            price = step1.mulDiv(sqrtPriceX96, 1 << 96);
        }
    }

    /// @notice Mean tick from oracle cumulative delta to sqrtPriceX96 (Q64.96).
    function _sqrtPriceX96FromTickCumulativeDelta(
        int56 tickCumulativesDelta,
        uint32 window
    ) internal pure returns (uint160 sqrtPriceX96) {
        if (window == 0) revert ZeroTwapWindow();
        int56 denom = int56(uint56(window));
        int256 avgTickLong = int256(tickCumulativesDelta) / int256(denom);
        if (tickCumulativesDelta < 0 && (tickCumulativesDelta % denom != 0)) {
            --avgTickLong;
        }
        if (avgTickLong < int256(type(int24).min) || avgTickLong > int256(type(int24).max)) revert TickOutOfBounds();
        int24 avgTick = int24(avgTickLong);
        sqrtPriceX96 = TickMath.getSqrtRatioAtTick(avgTick);
    }
}
