/**
 * Signed-cast regression PoC (CHANGELOG 2.8.1).
 *
 * `int256(amount)` for `amount > 2^255 - 1` is `amount - 2^256` (negative).
 *   Deposit, legacy: `depositLiquidity(2^256 - 1)` shrinks a seeded buffer by 1 and pulls the tokens.
 *   Deposit, production: `amount.toInt256()` reverts `SafeCastOverflowedUintToInt`; buffer and balances stay put.
 *   Withdraw above `int256.max` does not pay out on either path: the legacy flipped add overflows, production
 *   reverts at the cast. An in-range withdraw of 100 still succeeds on both.
 *   Buy-leg settlement of `-200` still reduces the buffer; `type(int256).min` reverts
 *   `SafeCastOverflowedIntToUint` and leaves the buffer unchanged.
 */
import { expect } from "chai";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers } from "../helpers/hh";
import { deployUUPSProxy, deployOrionConfigForTests } from "../helpers/deployUpgradeable";
import { resetNetwork } from "../helpers/resetNetwork";
import type {
  LiquidityOrchestratorBufferHarness,
  MockSP1Verifier,
  MockUnderlyingAsset,
  PriceAdapterRegistry,
  UnsafeSignedCastOrchestrator,
} from "../../typechain-types";

const MAX_UINT = 2n ** 256n - 1n;
const MIN_INT = -(2n ** 255n);
const PHASE_PVO = 4;
const VKEY = "0x007ccff4696ddd1d62fec2a106aa50309ba0fdee8fc2bcbc9c0b5ea68fe200f3";

describe("Unsafe signed-cast regression PoCs", function () {
  before(async function () {
    await resetNetwork();
  });

  async function deployUnderlying(): Promise<MockUnderlyingAsset> {
    const underlying = (await (
      await ethers.getContractFactory("MockUnderlyingAsset")
    ).deploy(6)) as unknown as MockUnderlyingAsset;
    await underlying.waitForDeployment();
    return underlying;
  }

  async function deployLegacy(underlying: MockUnderlyingAsset): Promise<UnsafeSignedCastOrchestrator> {
    const twin = (await (
      await ethers.getContractFactory("UnsafeSignedCastOrchestrator")
    ).deploy(await underlying.getAddress())) as unknown as UnsafeSignedCastOrchestrator;
    await twin.waitForDeployment();
    return twin;
  }

  async function deployProduction(owner: SignerWithAddress, underlying: MockUnderlyingAsset) {
    const [, automation] = await ethers.getSigners();
    const orionConfig = await deployOrionConfigForTests(owner, await underlying.getAddress());
    const registry = await deployUUPSProxy<PriceAdapterRegistry>(
      "PriceAdapterRegistry",
      [await orionConfig.getAddress()],
      owner,
    );
    await orionConfig.setPriceAdapterRegistry(await registry.getAddress());

    const mockVerifier = (await (
      await ethers.getContractFactory("MockSP1Verifier")
    ).deploy()) as unknown as MockSP1Verifier;
    await mockVerifier.waitForDeployment();

    const harness = await deployUUPSProxy<LiquidityOrchestratorBufferHarness>(
      "LiquidityOrchestratorBufferHarness",
      [await orionConfig.getAddress(), automation.address, await mockVerifier.getAddress(), VKEY],
      owner,
    );
    await orionConfig.setLiquidityOrchestrator(await harness.getAddress());
    return harness;
  }

  describe("depositLiquidity", function () {
    it("legacy twin: deposit of uint256.max shrinks the buffer by 1", async function () {
      const [owner] = await ethers.getSigners();
      const underlying = await deployUnderlying();
      const twin = await deployLegacy(underlying);
      const seed = 100n;

      await twin.setBufferAmount(seed);
      await underlying.mint(owner.address, MAX_UINT);
      await underlying.connect(owner).approve(await twin.getAddress(), MAX_UINT);

      await twin.connect(owner).depositLiquidity(MAX_UINT);

      expect(await twin.bufferAmount()).to.equal(seed - 1n);
      expect(await underlying.balanceOf(await twin.getAddress())).to.equal(MAX_UINT);
      expect(await underlying.balanceOf(owner.address)).to.equal(0n);
    });

    it("production: deposit of uint256.max reverts and leaves buffer and balances unchanged", async function () {
      const [owner] = await ethers.getSigners();
      const underlying = await deployUnderlying();
      const harness = await deployProduction(owner, underlying);
      const seed = 100n;

      await harness.h_setBufferAmount(seed);
      await underlying.mint(owner.address, MAX_UINT);
      await underlying.connect(owner).approve(await harness.getAddress(), MAX_UINT);

      await expect(harness.connect(owner).depositLiquidity(MAX_UINT))
        .to.be.revertedWithCustomError(harness, "SafeCastOverflowedUintToInt")
        .withArgs(MAX_UINT);

      expect(await harness.bufferAmount()).to.equal(seed);
      expect(await underlying.balanceOf(owner.address)).to.equal(MAX_UINT);
      expect(await underlying.balanceOf(await harness.getAddress())).to.equal(0n);
    });

    it("in-range deposit of 100 increases the buffer on both paths", async function () {
      const [owner] = await ethers.getSigners();
      const amount = 100n;

      const legacyUnderlying = await deployUnderlying();
      const twin = await deployLegacy(legacyUnderlying);
      await legacyUnderlying.mint(owner.address, amount);
      await legacyUnderlying.connect(owner).approve(await twin.getAddress(), amount);
      await twin.connect(owner).depositLiquidity(amount);
      expect(await twin.bufferAmount()).to.equal(amount);

      const productionUnderlying = await deployUnderlying();
      const harness = await deployProduction(owner, productionUnderlying);
      await productionUnderlying.mint(owner.address, amount);
      await productionUnderlying.connect(owner).approve(await harness.getAddress(), amount);
      await harness.connect(owner).depositLiquidity(amount);
      expect(await harness.bufferAmount()).to.equal(amount);
    });
  });

  describe("withdrawLiquidity", function () {
    it("legacy twin: withdraw of uint256.max reverts on the flipped add and transfers nothing", async function () {
      const [owner] = await ethers.getSigners();
      const underlying = await deployUnderlying();
      const twin = await deployLegacy(underlying);

      await twin.setBufferAmount(MAX_UINT);
      await underlying.mint(await twin.getAddress(), MAX_UINT);

      // int256(2^256-1) = -1, so -int256(amount) = +1 and buffer += 1 overflows.
      await expect(twin.connect(owner).withdrawLiquidity(MAX_UINT)).to.be.revertedWithPanic(0x11);

      expect(await twin.bufferAmount()).to.equal(MAX_UINT);
      expect(await underlying.balanceOf(await twin.getAddress())).to.equal(MAX_UINT);
      expect(await underlying.balanceOf(owner.address)).to.equal(0n);
    });

    it("production: withdraw of uint256.max reverts at the cast and transfers nothing", async function () {
      const [owner] = await ethers.getSigners();
      const underlying = await deployUnderlying();
      const harness = await deployProduction(owner, underlying);

      await harness.h_setBufferAmount(MAX_UINT);
      await underlying.mint(await harness.getAddress(), MAX_UINT);

      await expect(harness.connect(owner).withdrawLiquidity(MAX_UINT))
        .to.be.revertedWithCustomError(harness, "SafeCastOverflowedUintToInt")
        .withArgs(MAX_UINT);

      expect(await harness.bufferAmount()).to.equal(MAX_UINT);
      expect(await underlying.balanceOf(await harness.getAddress())).to.equal(MAX_UINT);
      expect(await underlying.balanceOf(owner.address)).to.equal(0n);
    });

    it("in-range withdraw of 100 succeeds on both paths", async function () {
      const [owner] = await ethers.getSigners();
      const amount = 100n;

      const legacyUnderlying = await deployUnderlying();
      const twin = await deployLegacy(legacyUnderlying);
      await twin.setBufferAmount(amount);
      await legacyUnderlying.mint(await twin.getAddress(), amount);
      await twin.connect(owner).withdrawLiquidity(amount);
      expect(await twin.bufferAmount()).to.equal(0n);
      expect(await legacyUnderlying.balanceOf(owner.address)).to.equal(amount);
      expect(await legacyUnderlying.balanceOf(await twin.getAddress())).to.equal(0n);

      const productionUnderlying = await deployUnderlying();
      const harness = await deployProduction(owner, productionUnderlying);
      await harness.h_setBufferAmount(amount);
      await productionUnderlying.mint(await harness.getAddress(), amount);
      await harness.connect(owner).withdrawLiquidity(amount);
      expect(await harness.bufferAmount()).to.equal(0n);
      expect(await productionUnderlying.balanceOf(owner.address)).to.equal(amount);
      expect(await productionUnderlying.balanceOf(await harness.getAddress())).to.equal(0n);
    });
  });

  describe("buy-leg settlement", function () {
    it("in-range negative bufferVariation reduces the buffer", async function () {
      const [owner] = await ethers.getSigners();
      const underlying = await deployUnderlying();
      const harness = await deployProduction(owner, underlying);

      await harness.h_setPhase(PHASE_PVO);
      await harness.h_setBufferAmount(1_000n);

      await harness.h_applyBuyLegSettlement(-200n, 0n);

      expect(await harness.bufferAmount()).to.equal(800n);
    });

    it("type(int256).min reverts and leaves the buffer unchanged", async function () {
      const [owner] = await ethers.getSigners();
      const underlying = await deployUnderlying();
      const harness = await deployProduction(owner, underlying);

      await harness.h_setPhase(PHASE_PVO);
      await harness.h_setBufferAmount(1_000n);

      await expect(harness.h_applyBuyLegSettlement(MIN_INT, 0n))
        .to.be.revertedWithCustomError(harness, "SafeCastOverflowedIntToUint")
        .withArgs(MIN_INT);

      expect(await harness.bufferAmount()).to.equal(1_000n);
    });
  });
});
