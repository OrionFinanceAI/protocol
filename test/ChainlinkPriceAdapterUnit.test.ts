/**
 * ChainlinkPriceAdapter Unit Tests (no mainnet fork required)
 *
 * Covers the quoteFeed cross-rate normalisation path using MockChainlinkFeed.
 */

import { expect } from "chai";
import { ethers } from "./helpers/hh";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type { ChainlinkPriceAdapter, MockChainlinkFeed } from "../typechain-types";

const STALENESS = 3_600; // 1 hour
const MAX_PRICE = ethers.MaxUint256;

describe("ChainlinkPriceAdapter — unit tests (no fork)", function () {
  let owner: SignerWithAddress;
  let adapter: ChainlinkPriceAdapter;
  let baseFeed: MockChainlinkFeed;
  let quoteFeed: MockChainlinkFeed;
  let asset: string;

  const BASE_DECIMALS = 8;
  const BASE_ANSWER = 2_000_00000000n; // $2 000 in 8-dec fixed-point

  // USDC/USD: 8 dec, $1.0001  →  answer =  1_00010000
  const QUOTE_DECIMALS = 8;
  const QUOTE_ANSWER = 1_00010000n; // $1.0001 in 8-dec fixed-point

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    asset = owner.address; // reuse signer address as a dummy asset address

    const AdapterF = await ethers.getContractFactory("ChainlinkPriceAdapter");
    adapter = (await AdapterF.deploy()) as unknown as ChainlinkPriceAdapter;
    await adapter.waitForDeployment();

    const FeedF = await ethers.getContractFactory("MockChainlinkFeed");
    baseFeed = (await FeedF.deploy(BASE_DECIMALS, BASE_ANSWER)) as unknown as MockChainlinkFeed;
    quoteFeed = (await FeedF.deploy(QUOTE_DECIMALS, QUOTE_ANSWER)) as unknown as MockChainlinkFeed;
    await Promise.all([baseFeed.waitForDeployment(), quoteFeed.waitForDeployment()]);
  });

  // ── configureFeed ─────────────────────────────────────────────────────────

  describe("configureFeed", function () {
    it("zero quoteFeed stores address(0) and scaleFactor=0 (single-feed path)", async function () {
      await adapter.configureFeed(
        asset,
        await baseFeed.getAddress(),
        false,
        STALENESS,
        1,
        MAX_PRICE,
        ethers.ZeroAddress,
      );
      const cfg = await adapter.feedConfigOf(asset);
      expect(cfg.quoteFeed).to.equal(ethers.ZeroAddress);
      expect(cfg.scaleFactor).to.equal(0n);
    });

    it("non-zero quoteFeed stores address and correct scaleFactor", async function () {
      // scaleFactor = 10^(quoteDecimals + 18) / 10^baseDecimals = 10^(8+18-8) = 10^18
      await adapter.configureFeed(
        asset,
        await baseFeed.getAddress(),
        false,
        STALENESS,
        1,
        MAX_PRICE,
        await quoteFeed.getAddress(),
      );
      const cfg = await adapter.feedConfigOf(asset);
      expect(cfg.quoteFeed).to.equal(await quoteFeed.getAddress());
      expect(cfg.scaleFactor).to.equal(10n ** 18n);
    });

    it("scaleFactor correct when base=18dec, quote=8dec → 10^8", async function () {
      const FeedF = await ethers.getContractFactory("MockChainlinkFeed");
      const base18 = (await FeedF.deploy(18, 1n)) as unknown as MockChainlinkFeed;
      await base18.waitForDeployment();
      // scaleFactor = 10^(8+18) / 10^18 = 10^8
      await adapter.configureFeed(
        asset,
        await base18.getAddress(),
        false,
        STALENESS,
        0,
        MAX_PRICE,
        await quoteFeed.getAddress(),
      );
      const cfg = await adapter.feedConfigOf(asset);
      expect(cfg.scaleFactor).to.equal(10n ** 8n);
    });

    it("emits FeedConfigured with quoteFeed field", async function () {
      const quoteAddr = await quoteFeed.getAddress();
      await expect(adapter.configureFeed(asset, await baseFeed.getAddress(), false, STALENESS, 1, MAX_PRICE, quoteAddr))
        .to.emit(adapter, "FeedConfigured")
        .withArgs(asset, await baseFeed.getAddress(), false, STALENESS, 1n, MAX_PRICE, quoteAddr);
    });

    it("rejects inverse=true combined with non-zero quoteFeed", async function () {
      await expect(
        adapter.configureFeed(
          asset,
          await baseFeed.getAddress(),
          true,
          STALENESS,
          1,
          MAX_PRICE,
          await quoteFeed.getAddress(),
        ),
      ).to.be.revertedWithCustomError(adapter, "InvalidArguments");
    });

    it("rejects non-contract quoteFeed address", async function () {
      await expect(
        adapter.configureFeed(asset, await baseFeed.getAddress(), false, STALENESS, 1, MAX_PRICE, owner.address),
      ).to.be.rejected;
    });
  });

  // ── validatePriceAdapter ──────────────────────────────────────────────────

  describe("validatePriceAdapter", function () {
    it("passes when both feeds are live and positive", async function () {
      await adapter.configureFeed(
        asset,
        await baseFeed.getAddress(),
        false,
        STALENESS,
        1,
        MAX_PRICE,
        await quoteFeed.getAddress(),
      );
      await expect(adapter.validatePriceAdapter(asset)).to.not.be.rejected;
    });

    it("passes single-feed path when base feed is live", async function () {
      await adapter.configureFeed(
        asset,
        await baseFeed.getAddress(),
        false,
        STALENESS,
        1,
        MAX_PRICE,
        ethers.ZeroAddress,
      );
      await expect(adapter.validatePriceAdapter(asset)).to.not.be.rejected;
    });

    it("reverts InvalidAdapter when baseFeed.latestRoundData answer is zero", async function () {
      await baseFeed.setAnswer(0);
      await adapter.configureFeed(
        asset,
        await baseFeed.getAddress(),
        false,
        STALENESS,
        1,
        MAX_PRICE,
        ethers.ZeroAddress,
      );
      await expect(adapter.validatePriceAdapter(asset)).to.be.revertedWithCustomError(adapter, "InvalidAdapter");
    });

    it("reverts InvalidAdapter when quoteFeed.latestRoundData answer is zero", async function () {
      await quoteFeed.setAnswer(0);
      await adapter.configureFeed(
        asset,
        await baseFeed.getAddress(),
        false,
        STALENESS,
        1,
        MAX_PRICE,
        await quoteFeed.getAddress(),
      );
      await expect(adapter.validatePriceAdapter(asset)).to.be.revertedWithCustomError(adapter, "InvalidAdapter");
    });

    it("reverts InvalidAdapter when quoteFeed.latestRoundData answer is negative", async function () {
      await quoteFeed.setAnswer(-1);
      await adapter.configureFeed(
        asset,
        await baseFeed.getAddress(),
        false,
        STALENESS,
        1,
        MAX_PRICE,
        await quoteFeed.getAddress(),
      );
      await expect(adapter.validatePriceAdapter(asset)).to.be.revertedWithCustomError(adapter, "InvalidAdapter");
    });
  });

  // ── getPriceData ──────────────────────────────────────────────────────────

  describe("getPriceData", function () {
    it("returns adjustedPrice in 18 decimals for two-feed path", async function () {
      await adapter.configureFeed(
        asset,
        await baseFeed.getAddress(),
        false,
        STALENESS,
        1,
        MAX_PRICE,
        await quoteFeed.getAddress(),
      );

      const [price, decimals] = await adapter.getPriceData(asset);

      const expected = (BASE_ANSWER * 10n ** 18n) / QUOTE_ANSWER;
      expect(decimals).to.equal(18);
      expect(price).to.equal(expected);
    });

    it("single-feed path unchanged — returns raw answer and feed decimals", async function () {
      await adapter.configureFeed(
        asset,
        await baseFeed.getAddress(),
        false,
        STALENESS,
        1,
        MAX_PRICE,
        ethers.ZeroAddress,
      );
      const [price, decimals] = await adapter.getPriceData(asset);
      expect(price).to.equal(BASE_ANSWER);
      expect(decimals).to.equal(BASE_DECIMALS);
    });

    it("reverts StalePrice when quoteFeed answer is stale", async function () {
      await adapter.configureFeed(
        asset,
        await baseFeed.getAddress(),
        false,
        STALENESS,
        1,
        MAX_PRICE,
        await quoteFeed.getAddress(),
      );
      // Push updatedAt back beyond maxStaleness
      const now = (await ethers.provider.getBlock("latest"))!.timestamp;
      await quoteFeed.setUpdatedAt(now - STALENESS - 1);
      await expect(adapter.getPriceData(asset)).to.be.revertedWithCustomError(adapter, "StalePrice");
    });

    it("reverts InvalidPrice when quoteFeed answer is zero", async function () {
      await adapter.configureFeed(
        asset,
        await baseFeed.getAddress(),
        false,
        STALENESS,
        1,
        MAX_PRICE,
        await quoteFeed.getAddress(),
      );
      await quoteFeed.setAnswer(0);
      await expect(adapter.getPriceData(asset)).to.be.revertedWithCustomError(adapter, "InvalidPrice");
    });

    it("reverts InvalidPrice when quoteFeed answer is negative", async function () {
      await adapter.configureFeed(
        asset,
        await baseFeed.getAddress(),
        false,
        STALENESS,
        1,
        MAX_PRICE,
        await quoteFeed.getAddress(),
      );
      await quoteFeed.setAnswer(-1);
      await expect(adapter.getPriceData(asset)).to.be.revertedWithCustomError(adapter, "InvalidPrice");
    });
  });
});
