// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IPriceAdapter } from "../interfaces/IPriceAdapter.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title ChainlinkPriceAdapter
 * @notice Price adapter for assets using Chainlink oracle feeds.
 *         Supports an optional quote feed for cross-rate normalisation (e.g. ETH/USD / USDC/USD
 *         to obtain ETH/USDC), which eliminates the implicit USD = USDC assumption.
 * @author Orion Finance
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract ChainlinkPriceAdapter is IPriceAdapter, Ownable2Step {
    /**
     * @notice Per-asset feed configuration.
     * @param feed Chainlink base aggregator (e.g. ETH/USD).
     * @param quoteFeed Optional quote aggregator (e.g. USDC/USD); address(0) = single-feed path.
     * @param isInverse True when the base feed returns the reciprocal rate (e.g. USDC/ETH).
     * @param maxStaleness Maximum acceptable age in seconds for both feed answers.
     * @param minPrice Minimum acceptable base feed answer (circuit-breaker lower bound).
     * @param maxPrice Maximum acceptable base feed answer (circuit-breaker upper bound).
     * @param scaleFactor Pre-computed at configure time as 10^(quoteDecimals + PRICE_DECIMALS) / 10^baseDecimals.
     *        Used only when quoteFeed != address(0) to produce a PRICE_DECIMALS-precision cross-rate.
     */
    struct FeedConfig {
        address feed;
        address quoteFeed;
        bool isInverse;
        uint256 maxStaleness;
        uint256 minPrice;
        uint256 maxPrice;
        uint256 scaleFactor;
    }

    /// @notice Per-asset feed configuration store.
    mapping(address => FeedConfig) public feedConfigOf;

    /// @notice Precision used for inverse-feed output (1/price scaled to 10^INVERSE_DECIMALS).
    uint8 public constant INVERSE_DECIMALS = 18;

    /// @notice Precision of the cross-rate output when a quoteFeed is configured.
    ///         Kept separate from INVERSE_DECIMALS because each represents a distinct semantic concept
    ///         (inversion precision vs. cross-rate output precision) that could evolve independently.
    uint8 public constant PRICE_DECIMALS = 18;

    /// @notice Emitted when a Chainlink feed is configured for an asset
    /// @param asset The asset address
    /// @param feed The Chainlink base aggregator address
    /// @param inverse Whether this feed returns inverse pricing
    /// @param maxStaleness Maximum acceptable staleness in seconds
    /// @param minPrice Minimum acceptable price
    /// @param maxPrice Maximum acceptable price
    /// @param quoteFeed The optional quote aggregator address (address(0) if not set)
    event FeedConfigured(
        address indexed asset,
        address indexed feed,
        bool indexed inverse,
        uint256 maxStaleness,
        uint256 minPrice,
        uint256 maxPrice,
        address quoteFeed
    );

    constructor() Ownable(msg.sender) {}

    /**
     * @notice Configure Chainlink feed for an asset.
     * @param asset The asset address.
     * @param feed The Chainlink base aggregator address (e.g. ETH/USD).
     * @param inverse Whether this feed returns inverse pricing. Cannot be combined with quoteFeed.
     * @param _maxStaleness Maximum acceptable staleness in seconds for both feeds.
     * @param _minPrice Minimum acceptable base feed answer (in base feed decimals).
     * @param _maxPrice Maximum acceptable base feed answer (in base feed decimals).
     * @param quoteFeed Optional second Chainlink aggregator used as the quote denominator (e.g. USDC/USD).
     *        Pass address(0) for single-feed behaviour (existing 6-arg call sites must add this arg).
     *        When set, getPriceData returns baseFeedPrice * scaleFactor / quoteFeedPrice
     *        with output decimals equal to PRICE_DECIMALS (18).
     * @dev scaleFactor is computed once at configure time to keep runtime cost minimal.
     */
    function configureFeed(
        address asset,
        address feed,
        bool inverse,
        uint256 _maxStaleness,
        uint256 _minPrice,
        uint256 _maxPrice,
        address quoteFeed
    ) external onlyOwner {
        if (asset == address(0) || feed == address(0)) revert ErrorsLib.ZeroAddress();
        if (_maxStaleness == 0) revert ErrorsLib.InvalidArguments();
        if (_maxPrice == 0) revert ErrorsLib.InvalidArguments();
        if (_minPrice > _maxPrice) revert ErrorsLib.InvalidArguments();
        if (inverse && quoteFeed != address(0)) revert ErrorsLib.InvalidArguments();

        uint8 baseDecimals = 0;
        try AggregatorV3Interface(feed).decimals() returns (uint8 d) {
            baseDecimals = d;
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }

        uint256 scaleFactor_ = 0;
        if (quoteFeed != address(0)) {
            uint8 quoteDecimals = 0;
            try AggregatorV3Interface(quoteFeed).decimals() returns (uint8 d) {
                quoteDecimals = d;
            } catch {
                revert ErrorsLib.InvalidAdapter(asset);
            }

            scaleFactor_ = (10 ** (uint256(quoteDecimals) + PRICE_DECIMALS)) / (10 ** uint256(baseDecimals));
            if (scaleFactor_ == 0) revert ErrorsLib.InvalidArguments();
        }

        feedConfigOf[asset] = FeedConfig({
            feed: feed,
            quoteFeed: quoteFeed,
            isInverse: inverse,
            maxStaleness: _maxStaleness,
            minPrice: _minPrice,
            maxPrice: _maxPrice,
            scaleFactor: scaleFactor_
        });

        emit FeedConfigured(asset, feed, inverse, _maxStaleness, _minPrice, _maxPrice, quoteFeed);
    }

    /// @inheritdoc IPriceAdapter
    function validatePriceAdapter(address asset) external view override {
        FeedConfig memory feedConfig = feedConfigOf[asset];
        if (feedConfig.feed == address(0)) revert ErrorsLib.InvalidAdapter(asset);

        try AggregatorV3Interface(feedConfig.feed).latestRoundData() returns (
            uint80,
            int256 baseAnswer,
            uint256,
            uint256,
            uint80
        ) {
            if (baseAnswer < 1) revert ErrorsLib.InvalidAdapter(asset);
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }

        if (feedConfig.quoteFeed != address(0)) {
            try AggregatorV3Interface(feedConfig.quoteFeed).latestRoundData() returns (
                uint80,
                int256 quoteAnswer,
                uint256,
                uint256,
                uint80
            ) {
                if (quoteAnswer < 1) revert ErrorsLib.InvalidAdapter(asset);
            } catch {
                revert ErrorsLib.InvalidAdapter(asset);
            }
        }
    }

    /// @inheritdoc IPriceAdapter
    // solhint-disable-next-line code-complexity, function-max-lines, use-natspec
    function getPriceData(address asset) external view override returns (uint256 price, uint8 decimals) {
        FeedConfig memory feedConfig = feedConfigOf[asset];
        if (feedConfig.feed == address(0)) revert ErrorsLib.AdapterNotSet();

        AggregatorV3Interface chainlinkFeed = AggregatorV3Interface(feedConfig.feed);
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) = chainlinkFeed
            .latestRoundData();

        if (answer < 1) revert ErrorsLib.InvalidPrice(asset, answer);
        if (updatedAt == 0) revert ErrorsLib.InvalidPrice(asset, answer);
        if (startedAt > block.timestamp) revert ErrorsLib.InvalidPrice(asset, answer);
        if (answeredInRound < roundId) revert ErrorsLib.StalePrice(asset);
        if (block.timestamp - updatedAt > feedConfig.maxStaleness) revert ErrorsLib.StalePrice(asset);

        uint256 rawPrice = uint256(answer);
        uint8 feedDecimals = chainlinkFeed.decimals();

        if (rawPrice < feedConfig.minPrice || rawPrice > feedConfig.maxPrice) {
            revert ErrorsLib.PriceOutOfBounds(asset, rawPrice, feedConfig.minPrice, feedConfig.maxPrice);
        }

        if (feedConfig.isInverse) {
            rawPrice = Math.mulDiv(10 ** INVERSE_DECIMALS, 10 ** feedDecimals, rawPrice);
            feedDecimals = INVERSE_DECIMALS;
        }

        if (feedConfig.quoteFeed != address(0)) {
            (
                uint80 qRoundId,
                int256 qAnswer,
                uint256 qStartedAt,
                uint256 qUpdatedAt,
                uint80 qAnsweredInRound
            ) = AggregatorV3Interface(feedConfig.quoteFeed).latestRoundData();

            if (qAnswer < 1) revert ErrorsLib.InvalidPrice(asset, qAnswer);
            if (qUpdatedAt == 0) revert ErrorsLib.InvalidPrice(asset, qAnswer);
            if (qStartedAt > block.timestamp) revert ErrorsLib.InvalidPrice(asset, qAnswer);
            if (qAnsweredInRound < qRoundId) revert ErrorsLib.StalePrice(asset);
            if (block.timestamp - qUpdatedAt > feedConfig.maxStaleness) revert ErrorsLib.StalePrice(asset);

            return (Math.mulDiv(rawPrice, feedConfig.scaleFactor, uint256(qAnswer)), PRICE_DECIMALS);
        }

        return (rawPrice, feedDecimals);
    }
}
