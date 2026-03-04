// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IPriceAdapter } from "../interfaces/IPriceAdapter.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title ChainlinkPriceAdapter
 * @notice Price adapter for assets using Chainlink oracle feeds
 * @author Orion Finance
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract ChainlinkPriceAdapter is IPriceAdapter, Ownable2Step {
    /// @notice Feed configuration struct
    struct FeedConfig {
        address feed; // Chainlink aggregator address
        bool isInverse; // Whether feed returns inverse pricing
        uint256 maxStaleness; // Maximum acceptable staleness in seconds
        uint256 minPrice; // Minimum acceptable price
        uint256 maxPrice; // Maximum acceptable price
    }

    /// @notice Mapping of asset to feed configuration
    mapping(address => FeedConfig) public feedConfigOf;

    /// @notice Decimals used for inverse calculation
    uint8 public constant INVERSE_DECIMALS = 18;

    /// @notice Emitted when a Chainlink feed is configured for an asset
    /// @param asset The asset address
    /// @param feed The Chainlink aggregator address
    /// @param inverse Whether this feed returns inverse pricing
    /// @param maxStaleness Maximum acceptable staleness in seconds
    /// @param minPrice Minimum acceptable price
    /// @param maxPrice Maximum acceptable price
    event FeedConfigured(
        address indexed asset,
        address indexed feed,
        bool indexed inverse,
        uint256 maxStaleness,
        uint256 minPrice,
        uint256 maxPrice
    );

    /**
     * @notice Constructor
     */
    constructor() Ownable(msg.sender) {}

    /**
     * @notice Configure Chainlink feed for an asset
     * @param asset The asset address
     * @param feed The Chainlink aggregator address
     * @param inverse Whether this feed returns inverse pricing (e.g., USDC/ETH instead of ETH/USDC)
     * @param _maxStaleness Maximum acceptable staleness in seconds (e.g., 3600 for 1 hour)
     * @param _minPrice Minimum acceptable price (in feed decimals)
     * @param _maxPrice Maximum acceptable price (in feed decimals)
     * @dev Only owner can configure feeds
     */
    function configureFeed(
        address asset,
        address feed,
        bool inverse,
        uint256 _maxStaleness,
        uint256 _minPrice,
        uint256 _maxPrice
    ) external onlyOwner {
        if (asset == address(0) || feed == address(0)) revert ErrorsLib.ZeroAddress();
        if (_maxStaleness == 0) revert ErrorsLib.InvalidArguments();
        if (_maxPrice == 0) revert ErrorsLib.InvalidArguments();
        if (_minPrice > _maxPrice) revert ErrorsLib.InvalidArguments();

        // Validate feed is callable
        // slither-disable-next-line unused-return
        try AggregatorV3Interface(feed).decimals() returns (uint8) {
            // solhint-disable-previous-line no-empty-blocks
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }

        feedConfigOf[asset] = FeedConfig({
            feed: feed,
            isInverse: inverse,
            maxStaleness: _maxStaleness,
            minPrice: _minPrice,
            maxPrice: _maxPrice
        });

        emit FeedConfigured(asset, feed, inverse, _maxStaleness, _minPrice, _maxPrice);
    }

    /// @inheritdoc IPriceAdapter
    function validatePriceAdapter(address asset) external view override {
        FeedConfig memory feedConfig = feedConfigOf[asset];
        if (feedConfig.feed == address(0)) revert ErrorsLib.InvalidAdapter(asset);

        // Verify feed is callable
        // slither-disable-next-line unused-return
        try AggregatorV3Interface(feedConfig.feed).decimals() returns (uint8) {
            // Decimals retrieved successfully
        } catch {
            revert ErrorsLib.InvalidAdapter(asset);
        }
    }

    /// @inheritdoc IPriceAdapter
    // solhint-disable-next-line code-complexity, function-max-lines, use-natspec
    function getPriceData(address asset) external view override returns (uint256 price, uint8 decimals) {
        FeedConfig memory feedConfig = feedConfigOf[asset];
        if (feedConfig.feed == address(0)) revert ErrorsLib.AdapterNotSet();

        AggregatorV3Interface chainlinkFeed = AggregatorV3Interface(feedConfig.feed);

        // Fetch latest round data
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) = chainlinkFeed
            .latestRoundData();

        // Check 1: No zero or negative prices
        if (answer < 1) revert ErrorsLib.InvalidPrice(asset, answer);

        // Check 2: Feed is initialized
        if (updatedAt == 0) revert ErrorsLib.InvalidPrice(asset, answer);

        // Check 3: No future timestamps
        if (startedAt > block.timestamp) revert ErrorsLib.InvalidPrice(asset, answer);

        // Check 4: Round id validity
        if (answeredInRound < roundId) revert ErrorsLib.StalePrice(asset);

        // Check 5: Staleness
        if (block.timestamp - updatedAt > feedConfig.maxStaleness) {
            revert ErrorsLib.StalePrice(asset);
        }

        uint256 rawPrice = uint256(answer);
        uint8 feedDecimals = chainlinkFeed.decimals();

        // Check 6: Price bounds
        if (rawPrice < feedConfig.minPrice || rawPrice > feedConfig.maxPrice) {
            revert ErrorsLib.PriceOutOfBounds(asset, rawPrice, feedConfig.minPrice, feedConfig.maxPrice);
        }

        // Handle inverse feeds
        if (feedConfig.isInverse) {
            uint256 inversePrecision = 10 ** INVERSE_DECIMALS;
            rawPrice = Math.mulDiv(inversePrecision, 10 ** feedDecimals, rawPrice);
            feedDecimals = INVERSE_DECIMALS;
        }

        return (rawPrice, feedDecimals);
    }
}
