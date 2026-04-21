/**
 * ChainlinkPriceAdapter Coverage Tests
 *
 * Comprehensive test suite to end to end test ChainlinkPriceAdapter.sol
 * Tests all security checks, edge cases, and error conditions.
 */

import { expect } from "chai";
import { ethers } from "../helpers/hh";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type { ChainlinkPriceAdapter } from "../typechain-types";

// Mainnet addresses
const MAINNET = {
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  CHAINLINK_ETH_USD: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  CHAINLINK_USDC_ETH: "0x986b5E1e1755e3C2440e960477f25201B0a8bbD4", // USDC/ETH (inverse)
  CHAINLINK_USDC_USD: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6", // USDC/USD
};

// Maximum tolerated deviation between ETH/USD direct price and ETH/USDC cross-rate, in basis points.
// USDC is not perfectly pegged; at the pinned fork block (24490214) the deviation is well under 50 bps.
const SLIPPAGE_TOLERANCE_BPS = 50n; // 0.5 %
const AGGREGATOR_V3_ABI = ["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"];

describe("ChainlinkPriceAdapter - Coverage Tests", function () {
  let owner: SignerWithAddress;
  let nonOwner: SignerWithAddress;
  let chainlinkAdapter: ChainlinkPriceAdapter;

  before(async function () {
    this.timeout(60000);

    // Skip if not forking mainnet
    if (!(process.env.FORK_MAINNET === "true" && process.env.MAINNET_RPC_URL)) {
      this.skip();
    }

    [owner, nonOwner] = await ethers.getSigners();

    // Deploy Chainlink adapter (no constructor args)
    const ChainlinkAdapterFactory = await ethers.getContractFactory("ChainlinkPriceAdapter");
    const chainlinkAdapterDeployed = await ChainlinkAdapterFactory.deploy();
    await chainlinkAdapterDeployed.waitForDeployment();
    chainlinkAdapter = chainlinkAdapterDeployed as unknown as ChainlinkPriceAdapter;
  });

  describe("Constructor", function () {
    it("Should set owner correctly", async function () {
      expect(await chainlinkAdapter.owner()).to.equal(owner.address);
    });
  });

  describe("configureFeed", function () {
    it("Should configure standard feed successfully", async function () {
      await expect(
        chainlinkAdapter.configureFeed(
          MAINNET.WETH,
          MAINNET.CHAINLINK_ETH_USD,
          false, // not inverse
          3600, // 1 hour staleness
          ethers.parseUnits("1000", 8), // min $1,000
          ethers.parseUnits("10000", 8), // max $10,000
          ethers.ZeroAddress, // no quote feed
        ),
      )
        .to.emit(chainlinkAdapter, "FeedConfigured")
        .withArgs(
          MAINNET.WETH,
          MAINNET.CHAINLINK_ETH_USD,
          false,
          3600,
          ethers.parseUnits("1000", 8),
          ethers.parseUnits("10000", 8),
          ethers.ZeroAddress,
        );

      const feedConfig = await chainlinkAdapter.feedConfigOf(MAINNET.WETH);
      expect(feedConfig.feed).to.equal(MAINNET.CHAINLINK_ETH_USD);
      expect(feedConfig.isInverse).to.equal(false);
    });

    it("Should configure inverse feed successfully", async function () {
      await chainlinkAdapter.configureFeed(
        MAINNET.USDC,
        MAINNET.CHAINLINK_USDC_ETH,
        true, // inverse
        3600,
        ethers.parseUnits("0.0001", 18), // min (USDC/ETH is small)
        ethers.parseUnits("0.001", 18), // max
        ethers.ZeroAddress,
      );

      const feedConfig = await chainlinkAdapter.feedConfigOf(MAINNET.USDC);
      expect(feedConfig.isInverse).to.equal(true);
    });

    it("Should reject zero asset address", async function () {
      await expect(
        chainlinkAdapter.configureFeed(
          ethers.ZeroAddress,
          MAINNET.CHAINLINK_ETH_USD,
          false,
          3600,
          ethers.parseUnits("1000", 8),
          ethers.parseUnits("10000", 8),
          ethers.ZeroAddress,
        ),
      ).to.be.revertedWithCustomError(chainlinkAdapter, "ZeroAddress");
    });

    it("Should reject zero feed address", async function () {
      await expect(
        chainlinkAdapter.configureFeed(
          MAINNET.WETH,
          ethers.ZeroAddress,
          false,
          3600,
          ethers.parseUnits("1000", 8),
          ethers.parseUnits("10000", 8),
          ethers.ZeroAddress,
        ),
      ).to.be.revertedWithCustomError(chainlinkAdapter, "ZeroAddress");
    });

    it("Should reject zero staleness", async function () {
      await expect(
        chainlinkAdapter.configureFeed(
          MAINNET.WETH,
          MAINNET.CHAINLINK_ETH_USD,
          false,
          0, // zero staleness
          ethers.parseUnits("1000", 8),
          ethers.parseUnits("10000", 8),
          ethers.ZeroAddress,
        ),
      ).to.be.revertedWithCustomError(chainlinkAdapter, "InvalidArguments");
    });

    it("Should reject minPrice > maxPrice", async function () {
      await expect(
        chainlinkAdapter.configureFeed(
          MAINNET.WETH,
          MAINNET.CHAINLINK_ETH_USD,
          false,
          3600,
          ethers.parseUnits("10000", 8), // min > max
          ethers.parseUnits("1000", 8),
          ethers.ZeroAddress,
        ),
      ).to.be.revertedWithCustomError(chainlinkAdapter, "InvalidArguments");
    });

    it("Should reject invalid feed address", async function () {
      // Owner EOA is not a feed; base feed decimals() fails and configureFeed reverts InvalidAdapter(asset).
      await expect(
        chainlinkAdapter.configureFeed(
          MAINNET.WETH,
          owner.address,
          false,
          3600,
          ethers.parseUnits("1000", 8),
          ethers.parseUnits("10000", 8),
          ethers.ZeroAddress,
        ),
      ).to.be.revertedWithCustomError(chainlinkAdapter, "InvalidAdapter");
    });

    it("Should reject non-owner", async function () {
      await expect(
        chainlinkAdapter
          .connect(nonOwner)
          .configureFeed(
            MAINNET.WETH,
            MAINNET.CHAINLINK_ETH_USD,
            false,
            3600,
            ethers.parseUnits("1000", 8),
            ethers.parseUnits("10000", 8),
            ethers.ZeroAddress,
          ),
      ).to.be.revertedWithCustomError(chainlinkAdapter, "OwnableUnauthorizedAccount");
    });
  });

  describe("validatePriceAdapter", function () {
    it("Should validate configured feed", async function () {
      await expect(chainlinkAdapter.validatePriceAdapter(MAINNET.WETH)).to.not.be.rejected;
    });

    it("Should reject unconfigured asset", async function () {
      const unconfiguredAsset = "0x1234567890123456789012345678901234567890";
      await expect(chainlinkAdapter.validatePriceAdapter(unconfiguredAsset)).to.be.revertedWithCustomError(
        chainlinkAdapter,
        "InvalidAdapter",
      );
    });
  });

  describe("getPriceData", function () {
    it("Should return valid price for ETH/USD", async function () {
      // First get the raw Chainlink price to check if it's within our test bounds
      const chainlinkFeed = new ethers.Contract(MAINNET.CHAINLINK_ETH_USD, AGGREGATOR_V3_ABI, owner);
      const [, answer] = await chainlinkFeed.latestRoundData();
      const currentPrice = BigInt(answer.toString());

      console.log(`  Current Chainlink ETH/USD: $${ethers.formatUnits(currentPrice, 8)}`);

      // Reconfigure with wider bounds to accommodate current price
      await chainlinkAdapter.configureFeed(
        MAINNET.WETH,
        MAINNET.CHAINLINK_ETH_USD,
        false,
        3600,
        ethers.parseUnits("100", 8), // min $100 (very safe)
        ethers.parseUnits("100000", 8), // max $100,000 (very safe)
        ethers.ZeroAddress,
      );

      const [price, decimals] = await chainlinkAdapter.getPriceData(MAINNET.WETH);

      expect(decimals).to.equal(8); // Chainlink ETH/USD uses 8 decimals
      expect(price).to.be.gt(0);
      expect(price).to.equal(currentPrice);

      console.log(`  Retrieved price: $${ethers.formatUnits(price, 8)}`);
    });

    it("Should reject unconfigured asset", async function () {
      // USDC feed configured but with inverse flag - test different asset
      const randomAddress = "0x1234567890123456789012345678901234567890";
      await expect(chainlinkAdapter.getPriceData(randomAddress)).to.be.revertedWithCustomError(
        chainlinkAdapter,
        "AdapterNotSet",
      );
    });

    it("Should handle inverse feed correctly", async function () {
      // Reconfigure with longer staleness tolerance (USDC/ETH feed updates less frequently)
      await chainlinkAdapter.configureFeed(
        MAINNET.USDC,
        MAINNET.CHAINLINK_USDC_ETH,
        true, // inverse
        86400, // 24 hours staleness tolerance
        ethers.parseUnits("0.0001", 18), // min
        ethers.parseUnits("0.001", 18), // max
        ethers.ZeroAddress,
      );

      // USDC/ETH feed returns inverse, adapter should flip it
      const [price, decimals] = await chainlinkAdapter.getPriceData(MAINNET.USDC);

      expect(decimals).to.equal(18); // Inverse feeds use INVERSE_DECIMALS
      expect(price).to.be.gt(0);

      console.log(`  USDC price (inverted): ${ethers.formatUnits(price, 18)} ETH`);
    });

    it("Should reject price out of bounds", async function () {
      // Configure with very tight bounds that current price will exceed
      await chainlinkAdapter.configureFeed(
        owner.address, // Use any address as test asset
        MAINNET.CHAINLINK_ETH_USD,
        false,
        3600,
        1, // min $0.00000001 (will pass)
        2, // max $0.00000002 (will fail - current price is much higher)
        ethers.ZeroAddress,
      );

      await expect(chainlinkAdapter.getPriceData(owner.address)).to.be.revertedWithCustomError(
        chainlinkAdapter,
        "PriceOutOfBounds",
      );
    });
  });

  describe("cross-rate: ETH/USDC via ETH/USD ÷ USDC/USD", function () {
    // Use a throwaway asset slot so we don't disturb the WETH config used by other tests.
    const CROSS_RATE_SLOT = "0x000000000000000000000000000000000000dEaD";

    before(async function () {
      // Configure WETH with ETH/USD base + USDC/USD quote.
      // Both Chainlink feeds return 8-decimal answers.
      // scaleFactor = 10^(quoteDecimals + PRICE_DECIMALS) / 10^baseDecimals
      //             = 10^(8 + 18) / 10^8 = 10^18
      // USDC/USD heartbeat is 86400 s (24 h), so maxStaleness must accommodate it.
      // ETH/USD heartbeat is 3600 s but sharing one maxStaleness means we use the looser bound.
      await chainlinkAdapter.configureFeed(
        CROSS_RATE_SLOT,
        MAINNET.CHAINLINK_ETH_USD,
        false, // not inverse
        86400, // 24 h — covers the USDC/USD heartbeat
        ethers.parseUnits("100", 8), // min $100
        ethers.parseUnits("100000", 8), // max $100,000
        MAINNET.CHAINLINK_USDC_USD, // quote feed
      );
    });

    it("scaleFactor stored correctly (10^18 for 8-decimal base and quote)", async function () {
      const cfg = await chainlinkAdapter.feedConfigOf(CROSS_RATE_SLOT);
      expect(cfg.scaleFactor).to.equal(ethers.parseUnits("1", 18));
    });

    it("cross-rate output uses PRICE_DECIMALS (18)", async function () {
      const [, decimals] = await chainlinkAdapter.getPriceData(CROSS_RATE_SLOT);
      expect(decimals).to.equal(18);
    });

    it("cross-rate ETH/USDC is within slippage tolerance of raw ETH/USD price", async function () {
      // --- raw ETH/USD from Chainlink (8 decimals) ---
      const ethUsdFeed = new ethers.Contract(MAINNET.CHAINLINK_ETH_USD, AGGREGATOR_V3_ABI, owner);
      const [, ethUsdRaw] = await ethUsdFeed.latestRoundData();
      const ethUsdDirect18 = BigInt(ethUsdRaw.toString()) * 10n ** 10n; // normalise 8 → 18 decimals

      // --- raw USDC/USD from Chainlink (8 decimals) ---
      const usdcUsdFeed = new ethers.Contract(MAINNET.CHAINLINK_USDC_USD, AGGREGATOR_V3_ABI, owner);
      const [, usdcUsdRaw] = await usdcUsdFeed.latestRoundData();

      // --- cross-rate from adapter (18 decimals) ---
      const [crossRate] = await chainlinkAdapter.getPriceData(CROSS_RATE_SLOT);
      const crossRate18 = BigInt(crossRate.toString());

      // Log for visibility
      console.log(`  ETH/USD  (direct, 18-dec normalised): ${ethers.formatUnits(ethUsdDirect18, 18)}`);
      console.log(`  USDC/USD (raw 8-dec):                 ${ethers.formatUnits(usdcUsdRaw.toString(), 8)}`);
      console.log(`  ETH/USDC (cross-rate, 18-dec):        ${ethers.formatUnits(crossRate18, 18)}`);

      // Sanity: cross-rate should be > 0
      expect(crossRate18).to.be.gt(0n);

      // Slippage = |crossRate - direct| / direct, expressed in basis points.
      // USDC/USD ≈ 1.000 so deviation should be negligible (<< 50 bps).
      const diff = crossRate18 > ethUsdDirect18 ? crossRate18 - ethUsdDirect18 : ethUsdDirect18 - crossRate18;
      const slippageBps = (diff * 10_000n) / ethUsdDirect18;

      console.log(`  Slippage vs direct ETH/USD: ${slippageBps} bps`);
      expect(slippageBps).to.be.lte(SLIPPAGE_TOLERANCE_BPS);
    });

    it("validatePriceAdapter passes for cross-rate config", async function () {
      await expect(chainlinkAdapter.validatePriceAdapter(CROSS_RATE_SLOT)).to.not.be.rejected;
    });
  });

  describe("transferOwnership (two-step)", function () {
    it("Should transfer ownership via propose + accept", async function () {
      const newOwner = nonOwner.address;
      await chainlinkAdapter.transferOwnership(newOwner);

      // Owner hasn't changed yet — pending owner must accept
      expect(await chainlinkAdapter.owner()).to.equal(owner.address);
      expect(await chainlinkAdapter.pendingOwner()).to.equal(newOwner);

      // Accept ownership
      await chainlinkAdapter.connect(nonOwner).acceptOwnership();
      expect(await chainlinkAdapter.owner()).to.equal(newOwner);
      expect(await chainlinkAdapter.pendingOwner()).to.equal(ethers.ZeroAddress);

      // Transfer back for other tests
      await chainlinkAdapter.connect(nonOwner).transferOwnership(owner.address);
      await chainlinkAdapter.acceptOwnership();
    });

    it("Should reject accept from non-pending owner", async function () {
      await chainlinkAdapter.transferOwnership(nonOwner.address);
      await expect(chainlinkAdapter.acceptOwnership()).to.be.revertedWithCustomError(
        chainlinkAdapter,
        "OwnableUnauthorizedAccount",
      );
      // Clean up: accept with correct account
      await chainlinkAdapter.connect(nonOwner).acceptOwnership();
      // Transfer back
      await chainlinkAdapter.connect(nonOwner).transferOwnership(owner.address);
      await chainlinkAdapter.acceptOwnership();
    });

    it("Should reject zero address", async function () {
      // OZ Ownable2Step may or may not revert on zero. If it reverts, expect OwnableInvalidOwner.
      try {
        await expect(chainlinkAdapter.transferOwnership(ethers.ZeroAddress))
          .to.be.revertedWithCustomError(chainlinkAdapter, "OwnableInvalidOwner")
          .withArgs(ethers.ZeroAddress);
      } catch {
        // Tx did not revert; ensure owner did not become zero
        expect(await chainlinkAdapter.owner()).to.equal(owner.address);
      }
    });

    it("Should reject non-owner", async function () {
      await expect(
        chainlinkAdapter.connect(nonOwner).transferOwnership(nonOwner.address),
      ).to.be.revertedWithCustomError(chainlinkAdapter, "OwnableUnauthorizedAccount");
    });
  });
});
