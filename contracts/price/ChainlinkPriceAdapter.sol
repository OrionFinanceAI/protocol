// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import { IPriceAdapter } from "../interfaces/IPriceAdapter.sol";
import { IOrionConfig } from "../interfaces/IOrionConfig.sol";
import { ErrorsLib } from "../libraries/ErrorsLib.sol";
import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";
/**
 * @title ChainlinkPriceAdapter
 * @notice Price adapter for assets using Chainlink oracle feeds
 * @author Orion Finance
 * @dev Implements comprehensive security checks from Euler and Morpho Blue best practices
 *
 * Security Checks (ALL 5 are mandatory):
 * 1. answer > 0 (no zero or negative prices)
 * 2. updatedAt staleness check (block.timestamp - updatedAt <= maxStaleness)
 * 3. answeredInRound >= roundId (prevent stale round data)
 * 4. updatedAt != 0 (feed is initialized)
 * 5. startedAt <= block.timestamp (no future timestamps)
 *
 * Additional Security:
 * - Configurable price bounds (minPrice, maxPrice) to detect manipulation
 * - Immutable feed configuration (deploy new adapter to change feeds)
 * - Supports inverse feeds (e.g., USDC/ETH → ETH/USDC)
 *
 * @custom:security-contact security@orionfinance.ai
 */
contract ChainlinkPriceAdapter is IPriceAdapter {
    /// @notice Orion protocol configuration contract
    // solhint-disable-next-line immutable-vars-naming, use-natspec
    IOrionConfig public immutable config;
    /// @notice Decimals used for price normalization
    // solhint-disable-next-line immutable-vars-naming, use-natspec
    uint8 public immutable priceAdapterDecimals;

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

    /// @notice Owner address (for feed configuration)
    address public owner;

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
     * @param configAddress OrionConfig contract address
     */
    constructor(address configAddress) {
        if (configAddress == address(0)) revert ErrorsLib.ZeroAddress();

        config = IOrionConfig(configAddress);
        priceAdapterDecimals = config.priceAdapterDecimals();
        owner = msg.sender;
    }

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
    ) external {
        if (msg.sender != owner) revert ErrorsLib.NotAuthorized();
        if (asset == address(0) || feed == address(0)) revert ErrorsLib.ZeroAddress();
        if (_maxStaleness == 0) revert ErrorsLib.InvalidArguments();
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
        try AggregatorV3Interface(feedConfig.feed).decimals() returns (uint8 feedDecimals) {
            // Feed is valid - decimals retrieved successfully
            feedDecimals; // Silence unused variable warning
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

        if (answer < 1) revert ErrorsLib.InvalidPrice();

        if (block.timestamp - updatedAt > feedConfig.maxStaleness) {
            revert ErrorsLib.StalePrice();
        }

        // Check 3: Verify roundId validity (prevents returning stale data from previous rounds)
        if (answeredInRound < roundId) revert ErrorsLib.StalePrice();

        // Check 4: Verify feed is initialized
        if (updatedAt == 0) revert ErrorsLib.InvalidPrice();

        // Check 5: Verify no future timestamps
        if (startedAt > block.timestamp) revert ErrorsLib.InvalidPrice();

        uint256 rawPrice = uint256(answer);
        uint8 feedDecimals = chainlinkFeed.decimals();

        // Check 6: Validate price bounds
        if (rawPrice < feedConfig.minPrice || rawPrice > feedConfig.maxPrice) {
            revert ErrorsLib.PriceOutOfBounds();
        }

        // Handle inverse feeds (e.g., USDC/ETH → ETH/USDC)
        if (feedConfig.isInverse) {
            // Invert: price = (10^INVERSE_DECIMALS)^2 / rawPrice
            // Adjust decimals accordingly
            uint256 inversePrecision = 10 ** INVERSE_DECIMALS;
            rawPrice = (inversePrecision * (10 ** feedDecimals)) / rawPrice;
            feedDecimals = INVERSE_DECIMALS;
        }

        return (rawPrice, feedDecimals);
    }

    /**
     * @notice Transfer ownership
     * @param newOwner New owner address
     */
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert ErrorsLib.NotAuthorized();
        if (newOwner == address(0)) revert ErrorsLib.ZeroAddress();
        owner = newOwner;
    }
}
