// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";

/// @dev Controllable Uniswap V3 pool mock for UniswapV3PoolPriceAdapter unit tests.
contract MockUniswapV3PoolForPriceAdapter {
    address public immutable TOKEN0;
    address public immutable TOKEN1;
    uint160 private _sqrtPriceX96;
    int24 private _twapTick;
    uint128 private _liquidity;
    uint16 private _observationCardinality;
    bool private _observeReverts;
    bool private _token0Reverts;
    bool private _token1Reverts;
    bool private _observeLengthMismatch;
    uint32 private _observationTimestamp;
    bool private _observationInitialized;
    uint16 private _observationIndex;
    bool private _useCustomCumulatives;
    int56 private _tickCumOlder;
    int56 private _tickCumNewer;

    constructor(
        address token0_,
        address token1_,
        uint160 sqrtPriceX96_,
        uint128 liquidity_,
        uint16 observationCardinality_,
        bool observeReverts_
    ) {
        TOKEN0 = token0_;
        TOKEN1 = token1_;
        _sqrtPriceX96 = sqrtPriceX96_;
        _liquidity = liquidity_;
        _observationCardinality = observationCardinality_;
        _observeReverts = observeReverts_;
        _observationTimestamp = uint32(block.timestamp);
        _observationInitialized = true;
        _observationIndex = 0;
        if (sqrtPriceX96_ > 0) {
            require(
                sqrtPriceX96_ >= TickMath.MIN_SQRT_RATIO && sqrtPriceX96_ < TickMath.MAX_SQRT_RATIO,
                "mock sqrt range"
            );
            _twapTick = TickMath.getTickAtSqrtRatio(sqrtPriceX96_);
        } else {
            _twapTick = 0;
        }
    }

    function setSqrtPriceX96(uint160 sqrtPriceX96_) external {
        _sqrtPriceX96 = sqrtPriceX96_;
        if (sqrtPriceX96_ > 0) {
            _twapTick = TickMath.getTickAtSqrtRatio(sqrtPriceX96_);
        }
    }

    function setTokenReverts(bool token0Reverts_, bool token1Reverts_) external {
        _token0Reverts = token0Reverts_;
        _token1Reverts = token1Reverts_;
    }

    function setObserveLengthMismatch(bool mismatch_) external {
        _observeLengthMismatch = mismatch_;
    }

    function setLiquidity(uint128 liquidity_) external {
        _liquidity = liquidity_;
    }

    function configureObservation(uint32 timestamp, bool initialized, uint16 index) external {
        _observationTimestamp = timestamp;
        _observationInitialized = initialized;
        _observationIndex = index;
    }

    /// @notice Override observe tick cumulatives: older = secondsAgos[0], newer = secondsAgos[1].
    function setObserveCumulatives(int56 older, int56 newer) external {
        _useCustomCumulatives = true;
        _tickCumOlder = older;
        _tickCumNewer = newer;
    }

    function token0() external view returns (address) {
        if (_token0Reverts) revert("token0 revert");
        return TOKEN0;
    }

    function token1() external view returns (address) {
        if (_token1Reverts) revert("token1 revert");
        return TOKEN1;
    }

    function liquidity() external view returns (uint128) {
        return _liquidity;
    }

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
        observationIndex = _observationIndex;
        observationCardinality = _observationCardinality;
        observationCardinalityNext = 0;
        feeProtocol = 0;
        unlocked = false;
    }

    function observations(
        uint256 index
    )
        external
        view
        returns (
            uint32 blockTimestamp,
            int56 tickCumulative,
            uint160 secondsPerLiquidityCumulativeX128,
            bool initialized
        )
    {
        if (index == _observationIndex) {
            blockTimestamp = _observationTimestamp;
            initialized = _observationInitialized;
        } else {
            blockTimestamp = 0;
            initialized = false;
        }
        tickCumulative = int56(_twapTick) * int56(uint56(blockTimestamp));
        secondsPerLiquidityCumulativeX128 = 0;
    }

    function observe(
        uint32[] calldata secondsAgos
    ) external view returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s) {
        if (_observeReverts) {
            revert("mock observe revert");
        }
        tickCumulatives = new int56[](secondsAgos.length);
        if (_observeLengthMismatch) {
            secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length + 1);
        } else {
            secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        }
        if (_useCustomCumulatives && secondsAgos.length >= 2) {
            tickCumulatives[0] = _tickCumOlder;
            tickCumulatives[1] = _tickCumNewer;
            return (tickCumulatives, secondsPerLiquidityCumulativeX128s);
        }
        int56 tick = int56(_twapTick);
        int56 cumAnchor = tick * 1_000_000;
        for (uint256 i = 0; i < secondsAgos.length; ) {
            tickCumulatives[i] = cumAnchor - tick * int56(uint56(secondsAgos[i]));
            unchecked {
                ++i;
            }
        }
    }
}
