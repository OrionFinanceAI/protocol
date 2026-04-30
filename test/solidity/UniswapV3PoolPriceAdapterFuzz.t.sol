// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { UniswapV3PoolPriceAdapter } from "../../contracts/price/UniswapV3PoolPriceAdapter.sol";

/// @title Uniswap V3 pool price adapter fuzz tests (Hardhat 3 native Solidity tests)
/// @notice Fuzzes the two-step `mulDiv` spot-price math used by `UniswapV3PoolPriceAdapter.getPriceData`,
///         plus a thin integration path with mocked pool + ERC20 metadata.
/// @dev No forge-std: guard clauses + `require` (same style as `MorphoBlueFuzz.t.sol`).
///
///      **Pure layer** — Mirrors `getPriceData` after `sqrtPriceX96 > 0`:
///      - USDC is token0: `price = precisionAmount * 2^192 / sqrtPriceX96²`
///      - USDC is token1: `price = precisionAmount * sqrtPriceX96² / 2^192`
///
///      **Sqrt bounds** — Values match Uniswap V3 TickMath MIN_SQRT_RATIO / MAX_SQRT_RATIO (constants inlined here;
///      the upstream TickMath library targets Solidity below 0.8.x, so it is not imported).
///
///      **Decimals** — `assetDecimals` is bounded so `precisionAmount = 10**(PRICE_DECIMALS + d)` stays practical for fuzz volume.
contract UniswapV3PoolPriceAdapterFuzzTest {
    using Math for uint256;

    uint8 internal constant _PRICE_DECIMALS = 10;

    /// @dev Matches `UniswapV3PoolPriceAdapter` constructor reading `IERC20Metadata(usdc).decimals()`.
    uint8 internal constant _MOCK_USDC_DECIMALS = 6;

    /// @dev Uniswap V3 TickMath.MIN_SQRT_RATIO (fixed-point sqrt price lower bound).
    uint160 internal constant _MIN_SQRT_RATIO = 4295128739;

    /// @dev Uniswap V3 TickMath.MAX_SQRT_RATIO (fixed-point sqrt price upper bound).
    uint160 internal constant _MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    /// @dev Lower sqrt bound for fuzzing (avoids double mulDiv flooring to zero at tiny sqrt).
    uint160 internal constant _FUZZ_SQRT_LO = uint160(1) << 70;

    /// @dev Upper sqrt bound for fuzzing (avoids token0 branch floor-to-zero when sqrt ≫ precision·2^96).
    uint160 internal constant _FUZZ_SQRT_HI = uint160(1) << 114;

    function _precisionAmount(uint8 assetDecimals) internal pure returns (uint256) {
        return 10 ** uint256(_PRICE_DECIMALS + assetDecimals);
    }

    /// @dev Mirror of `UniswapV3PoolPriceAdapter.getPriceData` price branch (non-zero sqrt only).
    function _priceLikeAdapter(
        uint160 sqrtPriceX96,
        uint8 assetDecimals,
        bool usdcIsToken0
    ) internal pure returns (uint256 price) {
        uint256 precisionAmount = _precisionAmount(assetDecimals);
        if (usdcIsToken0) {
            uint256 step1 = precisionAmount.mulDiv(1 << 96, sqrtPriceX96);
            price = step1.mulDiv(1 << 96, sqrtPriceX96);
        } else {
            uint256 step1 = precisionAmount.mulDiv(sqrtPriceX96, 1 << 96);
            price = step1.mulDiv(sqrtPriceX96, 1 << 96);
        }
    }

    /// @dev Clamp sqrt into [_FUZZ_SQRT_LO, _FUZZ_SQRT_HI] so spot math stays positive and monotonic (weak) stable.
    function _boundSqrt(uint160 sqrtRaw) internal pure returns (uint160) {
        uint160 lo = _MIN_SQRT_RATIO + 1;
        if (lo < _FUZZ_SQRT_LO) {
            lo = _FUZZ_SQRT_LO;
        }
        uint160 hi = _MAX_SQRT_RATIO - 1;
        if (hi > _FUZZ_SQRT_HI) {
            hi = _FUZZ_SQRT_HI;
        }
        require(lo <= hi, "fuzz sqrt range");
        return boundUint160(sqrtRaw, lo, hi);
    }

    // --- Pure math: both orderings ---

    /// @notice With fuzz sqrt clamp, replicated price is strictly positive.
    function testFuzz_PricePositive(uint160 sqrtRaw, uint256 assetDecimalsSeed, bool usdcIsToken0) public pure {
        uint160 sqrtPriceX96 = _boundSqrt(sqrtRaw);
        uint8 assetDecimals = boundUint8(assetDecimalsSeed, 6, 24);

        uint256 price = _priceLikeAdapter(sqrtPriceX96, assetDecimals, usdcIsToken0);
        require(price > 0, "price: positive");
    }

    /// @notice Monotonicity when USDC is token0: larger sqrt ⇒ smaller USDC per asset (∝ 1/s²).
    function testFuzz_Monotonic_DecreaseWhenUsdcIsToken0(
        uint160 sqrtLoRaw,
        uint160 sqrtHiRaw,
        uint256 assetDecimalsSeed
    ) public pure {
        uint160 sqrtLo = _boundSqrt(sqrtLoRaw);
        uint160 sqrtHi = _boundSqrt(sqrtHiRaw);
        if (sqrtLo >= sqrtHi) return;

        uint8 assetDecimals = boundUint8(assetDecimalsSeed, 6, 24);

        uint256 pLo = _priceLikeAdapter(sqrtLo, assetDecimals, true);
        uint256 pHi = _priceLikeAdapter(sqrtHi, assetDecimals, true);
        require(pLo >= pHi, "monotonic: USDC token0 non-increasing in sqrt");
    }

    /// @notice Monotonicity when USDC is token1: larger sqrt ⇒ larger USDC per asset (∝ s²).
    function testFuzz_Monotonic_IncreaseWhenUsdcIsToken1(
        uint160 sqrtLoRaw,
        uint160 sqrtHiRaw,
        uint256 assetDecimalsSeed
    ) public pure {
        uint160 sqrtLo = _boundSqrt(sqrtLoRaw);
        uint160 sqrtHi = _boundSqrt(sqrtHiRaw);
        if (sqrtLo >= sqrtHi) return;

        uint8 assetDecimals = boundUint8(assetDecimalsSeed, 6, 24);

        uint256 pLo = _priceLikeAdapter(sqrtLo, assetDecimals, false);
        uint256 pHi = _priceLikeAdapter(sqrtHi, assetDecimals, false);
        require(pLo <= pHi, "monotonic: USDC token1 non-decreasing in sqrt");
    }

    /// @notice Exact decade step on precision scalar (adapter scales linearly with this in reals).
    function test_PrecisionAmountDecadeStep() public pure {
        for (uint8 d = 6; d < 24; ) {
            require(_precisionAmount(d + 1) == _precisionAmount(d) * 10, "precision decade exact");
            unchecked {
                ++d;
            }
        }
    }

    // --- Integration: real adapter + mocks ---

    function testFuzz_GetPriceData_matchesPureFormula(
        uint160 sqrtRaw,
        uint256 assetDecimalsSeed,
        bool assetIsToken0
    ) public {
        uint160 sqrtPriceX96 = _boundSqrt(sqrtRaw);
        uint8 assetDecimals = boundUint8(assetDecimalsSeed, 6, 18);

        MockERC20 usdc = new MockERC20("USDC", "USDC", _MOCK_USDC_DECIMALS);
        MockERC20 asset = new MockERC20("AST", "AST", assetDecimals);

        address token0 = assetIsToken0 ? address(asset) : address(usdc);
        address token1 = assetIsToken0 ? address(usdc) : address(asset);

        MockUniswapV3Pool pool = new MockUniswapV3Pool(token0, token1, sqrtPriceX96);

        UniswapV3PoolPriceAdapter adapter = new UniswapV3PoolPriceAdapter(address(usdc), address(this));
        adapter.setPool(address(asset), address(pool));

        (uint256 priceOut, uint8 decimalsOut) = adapter.getPriceData(address(asset));
        require(decimalsOut == _PRICE_DECIMALS + _MOCK_USDC_DECIMALS, "decimals");

        bool usdcIsToken0 = !assetIsToken0;
        uint256 expected = _priceLikeAdapter(sqrtPriceX96, assetDecimals, usdcIsToken0);
        require(priceOut == expected, "integration: matches pure");
    }

    function test_RevertWhen_sqrtPriceZero() public {
        MockERC20 usdc = new MockERC20("USDC", "USDC", _MOCK_USDC_DECIMALS);
        MockERC20 asset = new MockERC20("AST", "AST", 18);

        MockUniswapV3Pool pool = new MockUniswapV3Pool(address(asset), address(usdc), 0);

        UniswapV3PoolPriceAdapter adapter = new UniswapV3PoolPriceAdapter(address(usdc), address(this));
        adapter.setPool(address(asset), address(pool));

        (bool ok, ) = address(adapter).staticcall(
            abi.encodeCall(UniswapV3PoolPriceAdapter.getPriceData, (address(asset)))
        );
        require(!ok, "expect revert sqrt=0");
    }

    function boundUint8(uint256 x, uint8 lo, uint8 hi) internal pure returns (uint8) {
        require(lo <= hi, "bound8");
        uint256 range = uint256(hi - lo) + 1;
        return uint8(lo + (x % range));
    }

    function boundUint160(uint160 x, uint160 lo, uint160 hi) internal pure returns (uint160) {
        require(lo <= hi, "bound160");
        if (x < lo) return lo;
        if (x > hi) return hi;
        return x;
    }
}

// ----- Mocks -----

contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }
}

contract MockUniswapV3Pool {
    address public immutable TOKEN0;
    address public immutable TOKEN1;
    uint160 private immutable _sqrtPriceX96;

    constructor(address token0_, address token1_, uint160 sqrtPriceX96_) {
        TOKEN0 = token0_;
        TOKEN1 = token1_;
        _sqrtPriceX96 = sqrtPriceX96_;
    }

    function token0() external view returns (address) {
        return TOKEN0;
    }

    function token1() external view returns (address) {
        return TOKEN1;
    }

    /// @dev Minimal `slot0` compatible with `IUniswapV3Pool.slot0()` — only sqrt used by adapter.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        sqrtPriceX96 = _sqrtPriceX96;
        tick = 0;
        observationIndex = 0;
        observationCardinality = 0;
        observationCardinalityNext = 0;
        feeProtocol = 0;
        unlocked = false;
    }
}
