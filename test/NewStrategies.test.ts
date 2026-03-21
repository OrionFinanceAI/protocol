import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import "@openzeppelin/hardhat-upgrades";
import type { ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";

import {
  MockUnderlyingAsset,
  MockERC4626Asset,
  OrionConfig,
  TransparentVaultFactory,
  OrionTransparentVault,
  KBestApyStrategist,
} from "../typechain-types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_SCALE = 1_000_000_000n;
// Must exceed KBestApyStrategist.MIN_WINDOW (1 hour = 3600 s); add buffer for block mining.
const PAST_MIN_WINDOW = 3_700;

/** KBestApyStrategist.WeightingMode */
const WEIGHTING_EQUAL = 0;
const WEIGHTING_APY = 1;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function createVault(
  factory: TransparentVaultFactory,
  creator: SignerWithAddress,
  strategistAddr: string,
): Promise<OrionTransparentVault> {
  const tx = await factory
    .connect(creator)
    .createVault(strategistAddr, "Test Vault", "TV", 0, 0, 0, ethers.ZeroAddress);
  const receipt = await tx.wait();
  const event = receipt?.logs.find((log) => {
    try {
      const parsed = factory.interface.parseLog(log);
      return parsed?.name === "OrionVaultCreated";
    } catch {
      return false;
    }
  });
  const parsed = factory.interface.parseLog(event!);
  return ethers.getContractAt("OrionTransparentVault", parsed!.args[0]) as unknown as Promise<OrionTransparentVault>;
}

/** Mint underlying tokens, approve, and deposit into an ERC4626 asset. */
async function mintAndDeposit(
  underlying: MockUnderlyingAsset,
  asset: MockERC4626Asset,
  user: SignerWithAddress,
  units: number,
  decimals: number,
): Promise<void> {
  const amount = ethers.parseUnits(String(units), decimals);
  await underlying.mint(user.address, amount);
  await underlying.connect(user).approve(await asset.getAddress(), amount);
  await asset.connect(user).deposit(amount, user.address);
}

/** Simulate yield gains by transferring underlying into the vault without minting shares. */
async function simulateGains(
  underlying: MockUnderlyingAsset,
  asset: MockERC4626Asset,
  gainer: SignerWithAddress,
  units: number,
  decimals: number,
): Promise<void> {
  const amount = ethers.parseUnits(String(units), decimals);
  await underlying.mint(gainer.address, amount);
  await underlying.connect(gainer).approve(await asset.getAddress(), amount);
  await asset.connect(gainer).simulateGains(amount);
}

/** Advance the chain past the MIN_WINDOW so that APY observations become valid. */
async function advancePastMinWindow(): Promise<void> {
  await ethers.provider.send("evm_increaseTime", [PAST_MIN_WINDOW]);
  await ethers.provider.send("evm_mine", []);
}

/** Parse CheckpointRecorded from a strategist tx receipt (ignores other contracts' logs). */
async function checkpointRecordedForAsset(
  strategy: KBestApyStrategist,
  receipt: ContractTransactionReceipt,
  assetAddress: string,
): Promise<{ sharePrice: bigint; timestamp: bigint } | undefined> {
  const iface = strategy.interface;
  const strategyAddr = (await strategy.getAddress()).toLowerCase();
  const want = assetAddress.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== strategyAddr) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name !== "CheckpointRecorded") continue;
      const asset = (parsed.args[0] as string).toLowerCase();
      if (asset !== want) continue;
      return {
        sharePrice: BigInt(parsed.args[1].toString()),
        timestamp: BigInt(parsed.args[2].toString()),
      };
    } catch {
      /* not a strategist event */
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared state
// ─────────────────────────────────────────────────────────────────────────────

describe("New Strategies", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let stranger: SignerWithAddress;

  let orionConfig: OrionConfig;
  let transparentVaultFactory: TransparentVaultFactory;
  let underlyingAsset: MockUnderlyingAsset;
  const underlyingDecimals = 12;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockPriceAdapter: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockExecutionAdapter: any;

  // Three ERC4626 mock assets; all whitelisted after beforeEach.
  let assetA: MockERC4626Asset;
  let assetB: MockERC4626Asset;
  let assetC: MockERC4626Asset;

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    this.timeout(90_000);
    [owner, , user, stranger] = await ethers.getSigners();

    const UnderlyingFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    underlyingAsset = (await UnderlyingFactory.deploy(underlyingDecimals)) as unknown as MockUnderlyingAsset;
    await underlyingAsset.waitForDeployment();

    const deployed = await deployUpgradeableProtocol(owner, underlyingAsset, owner);
    orionConfig = deployed.orionConfig;
    transparentVaultFactory = deployed.transparentVaultFactory;

    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    mockPriceAdapter = await MockPriceAdapterFactory.deploy();

    const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
    mockExecutionAdapter = await ERC4626ExecutionAdapterFactory.deploy(await orionConfig.getAddress());

    const ERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");
    assetA = (await ERC4626Factory.deploy(
      await underlyingAsset.getAddress(),
      "Asset A",
      "AA",
    )) as unknown as MockERC4626Asset;
    assetB = (await ERC4626Factory.deploy(
      await underlyingAsset.getAddress(),
      "Asset B",
      "AB",
    )) as unknown as MockERC4626Asset;
    assetC = (await ERC4626Factory.deploy(
      await underlyingAsset.getAddress(),
      "Asset C",
      "AC",
    )) as unknown as MockERC4626Asset;
    await Promise.all([assetA.waitForDeployment(), assetB.waitForDeployment(), assetC.waitForDeployment()]);

    for (const asset of [assetA, assetB, assetC]) {
      await orionConfig.addWhitelistedAsset(
        await asset.getAddress(),
        await mockPriceAdapter.getAddress(),
        await mockExecutionAdapter.getAddress(),
      );
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════

  describe("APY checkpoint mechanics (KBestApyStrategist)", function () {
    let strategy: KBestApyStrategist;
    let vault: OrionTransparentVault;

    beforeEach(async function () {
      const F = await ethers.getContractFactory("KBestApyStrategist");
      strategy = (await F.deploy(
        owner.address,
        await orionConfig.getAddress(),
        3,
        WEIGHTING_APY,
      )) as unknown as KBestApyStrategist;
      await strategy.waitForDeployment();
      vault = await createVault(transparentVaultFactory, owner, await strategy.getAddress());
    });

    it("first submitIntent emits CheckpointRecorded for funded ERC4626 vaults", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      // Constructor already bootstrapped checkpoints; advance so post-submit refresh is not rate-gated.
      await advancePastMinWindow();
      const tx = await strategy.submitIntent();
      const receipt = await tx.wait();
      expect(receipt).to.not.equal(null);
      const cp = await checkpointRecordedForAsset(strategy, receipt!, await assetA.getAddress());
      expect(cp).to.not.equal(undefined);
      // ERC4626 initial share price: convertToAssets(1e12) = 1e12 (1:1 with 12-dec underlying).
      expect(cp!.sharePrice).to.equal(10n ** BigInt(underlyingDecimals));
      expect(cp!.timestamp).to.be.gt(0n);
    });

    it("submitIntent emits CheckpointRecorded with correct asset and share price", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await advancePastMinWindow();
      const tx = await strategy.submitIntent();
      const receipt = await tx.wait();
      expect(receipt).to.not.equal(null);
      const cp = await checkpointRecordedForAsset(strategy, receipt!, await assetA.getAddress());
      expect(cp).to.not.equal(undefined);
      await expect(tx)
        .to.emit(strategy, "CheckpointRecorded")
        .withArgs(await assetA.getAddress(), 10n ** BigInt(underlyingDecimals), cp!.timestamp);
    });

    it("submitIntent is permissionless — stranger can call it", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await expect(strategy.connect(stranger).submitIntent()).to.not.be.reverted;
    });

    it("underlying (non-ERC4626) whitelisted asset gets no CheckpointRecorded from strategist", async function () {
      const tx = await strategy.submitIntent();
      const receipt = await tx.wait();
      expect(receipt).to.not.equal(null);
      const cp = await checkpointRecordedForAsset(strategy, receipt!, await underlyingAsset.getAddress());
      expect(cp).to.equal(undefined);
    });

    it("APY = 0 within MIN_WINDOW even if gains occurred → equal-weight fallback", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 1000, underlyingDecimals);

      // Baseline recorded at end of first submitIntent; gains before MIN_WINDOW elapses.
      await strategy.submitIntent();
      await simulateGains(underlyingAsset, assetA, user, 500, underlyingDecimals);

      await strategy.submitIntent();
      const [, weights] = await vault.getIntent();

      const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
      expect(total).to.equal(INTENT_SCALE);
      // All APYs are 0 → equal weight.
      expect(BigInt(weights[0])).to.equal(333_333_334n);
      expect(BigInt(weights[1])).to.equal(333_333_333n);
      expect(BigInt(weights[2])).to.equal(333_333_333n);
    });

    it("APY > 0 after MIN_WINDOW: highest-gain asset ranks first with largest weight", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 1000, underlyingDecimals);

      await strategy.submitIntent();
      await advancePastMinWindow();

      // assetA: 20% gain, assetB: 10% gain, assetC: no gain → APY_A = 2× APY_B > APY_C=0.
      await simulateGains(underlyingAsset, assetA, user, 200, underlyingDecimals);
      await simulateGains(underlyingAsset, assetB, user, 100, underlyingDecimals);

      await strategy.submitIntent();
      const [tokens, weights] = await vault.getIntent();

      const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
      expect(total).to.equal(INTENT_SCALE);

      // assetA must be ranked first and carry the highest weight.
      expect(tokens[0]).to.equal(await assetA.getAddress());
      expect(BigInt(weights[0])).to.be.gt(BigInt(weights[1]));
    });

    it("APY = 0 on price decline: losing asset treated as APY=0, equal-weight fallback", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 1000, underlyingDecimals);

      await strategy.submitIntent();
      await advancePastMinWindow();

      // assetA loses 10% of its underlying — share price falls below checkpoint.
      await assetA.connect(user).simulateLosses(ethers.parseUnits("100", underlyingDecimals), stranger.address);

      await strategy.submitIntent();
      const [, weights] = await vault.getIntent();

      const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
      expect(total).to.equal(INTENT_SCALE);
      // All APYs are 0 (A is losing, B and C are flat) → equal weight.
      expect(BigInt(weights[0])).to.equal(333_333_334n);
      expect(BigInt(weights[1])).to.equal(333_333_333n);
      expect(BigInt(weights[2])).to.equal(333_333_333n);
    });

    it("APY = 0 on flat price (no gains after window) → equal-weight fallback", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 1000, underlyingDecimals);

      await strategy.submitIntent();
      await advancePastMinWindow();
      // No gains → all prices flat → APY = 0 → equal weight.

      await strategy.submitIntent();
      const [, weights] = await vault.getIntent();

      const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
      expect(total).to.equal(INTENT_SCALE);
      expect(BigInt(weights[0])).to.equal(333_333_334n);
      expect(BigInt(weights[1])).to.equal(333_333_333n);
      expect(BigInt(weights[2])).to.equal(333_333_333n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // KBestApyWeightedAverage
  // ═══════════════════════════════════════════════════════════════════════════

  describe("KBestApyStrategist (ApyWeighted)", function () {
    let strategy: KBestApyStrategist;
    let vault: OrionTransparentVault;

    beforeEach(async function () {
      const F = await ethers.getContractFactory("KBestApyStrategist");
      strategy = (await F.deploy(
        owner.address,
        await orionConfig.getAddress(),
        2,
        WEIGHTING_APY,
      )) as unknown as KBestApyStrategist;
      await strategy.waitForDeployment();
      vault = await createVault(transparentVaultFactory, owner, await strategy.getAddress());
    });

    // ── setVault / vault errors ───────────────────────────────────────────────

    it("setVault: reverts ZeroAddress for address(0)", async function () {
      const F = await ethers.getContractFactory("KBestApyStrategist");
      const fresh = (await F.deploy(
        owner.address,
        await orionConfig.getAddress(),
        1,
        WEIGHTING_APY,
      )) as unknown as KBestApyStrategist;
      await fresh.waitForDeployment();
      await expect(fresh.setVault(ethers.ZeroAddress)).to.be.revertedWithCustomError(fresh, "ZeroAddress");
    });

    it("submitIntent: reverts ZeroAddress when no vault is linked", async function () {
      const F = await ethers.getContractFactory("KBestApyStrategist");
      const fresh = (await F.deploy(
        owner.address,
        await orionConfig.getAddress(),
        1,
        WEIGHTING_APY,
      )) as unknown as KBestApyStrategist;
      await fresh.waitForDeployment();
      await expect(fresh.connect(user).submitIntent()).to.be.revertedWithCustomError(fresh, "ZeroAddress");
    });

    it("submitIntent: reverts OrderIntentCannotBeEmpty when k=0", async function () {
      const F = await ethers.getContractFactory("KBestApyStrategist");
      const fresh = (await F.deploy(
        owner.address,
        await orionConfig.getAddress(),
        1,
        WEIGHTING_APY,
      )) as unknown as KBestApyStrategist;
      await fresh.waitForDeployment();
      const v = await createVault(transparentVaultFactory, owner, await fresh.getAddress());
      void v;
      await fresh.connect(owner).updateParameters(0);
      await expect(fresh.connect(user).submitIntent()).to.be.revertedWithCustomError(fresh, "OrderIntentCannotBeEmpty");
    });

    // ── Zero-APY fallback ─────────────────────────────────────────────────────

    it("zero APY fallback (k=2, no checkpoints): equal weight 5×10^8 each", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 1000, underlyingDecimals);

      await strategy.submitIntent();
      const [, weights] = await vault.getIntent();
      expect(weights.length).to.equal(2);

      const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
      expect(total).to.equal(INTENT_SCALE);
      expect(BigInt(weights[0])).to.equal(500_000_000n);
      expect(BigInt(weights[1])).to.equal(500_000_000n);
    });

    // ── Proportional APY weight math ──────────────────────────────────────────

    it("2:1 APY ratio → 666_666_667 + 333_333_333, sum = 10^9", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 1000, underlyingDecimals);

      await strategy.submitIntent();
      await advancePastMinWindow();

      // assetA: +20%, assetB: +10%, assetC: no gain.
      // APY_A = 2 × APY_B (same P0, same elapsed, gain ratio 2:1).
      await simulateGains(underlyingAsset, assetA, user, 200, underlyingDecimals);
      await simulateGains(underlyingAsset, assetB, user, 100, underlyingDecimals);

      // k=2 selects assetA (highest APY) and assetB (second highest).
      await strategy.submitIntent();
      const [tokens, weights] = await vault.getIntent();
      expect(tokens.length).to.equal(2);

      const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
      expect(total).to.equal(INTENT_SCALE);

      // Expect tokens sorted by descending APY.
      expect(tokens[0]).to.equal(await assetA.getAddress());
      expect(tokens[1]).to.equal(await assetB.getAddress());

      // mulDiv(2k, 1e9, 3k) = 666_666_666 → residual +1 → 666_666_667.
      expect(BigInt(weights[0])).to.equal(666_666_667n);
      // mulDiv(k, 1e9, 3k) = 333_333_333.
      expect(BigInt(weights[1])).to.equal(333_333_333n);
    });

    it("1:1 APY ratio: each of k=2 receives exactly 5×10^8", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 1000, underlyingDecimals);

      await strategy.submitIntent();
      await advancePastMinWindow();

      // Equal gains → equal APY.
      await simulateGains(underlyingAsset, assetA, user, 100, underlyingDecimals);
      await simulateGains(underlyingAsset, assetB, user, 100, underlyingDecimals);

      await strategy.submitIntent();
      const [, weights] = await vault.getIntent();

      const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
      expect(total).to.equal(INTENT_SCALE);
      expect(BigInt(weights[0])).to.equal(500_000_000n);
      expect(BigInt(weights[1])).to.equal(500_000_000n);
    });

    it("k=1: single top-APY asset receives exactly 10^9", async function () {
      await strategy.connect(owner).updateParameters(1);

      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 1000, underlyingDecimals);

      await strategy.submitIntent();
      await advancePastMinWindow();

      await simulateGains(underlyingAsset, assetA, user, 200, underlyingDecimals);
      await simulateGains(underlyingAsset, assetB, user, 50, underlyingDecimals);

      await strategy.submitIntent();
      const [tokens, weights] = await vault.getIntent();
      expect(tokens.length).to.equal(1);
      expect(tokens[0]).to.equal(await assetA.getAddress()); // highest APY
      expect(BigInt(weights[0])).to.equal(INTENT_SCALE);
    });

    it("k > n: clamps to n assets, sum still = 10^9", async function () {
      await strategy.connect(owner).updateParameters(10); // n=4 whitelisted (underlying + 3 mocks)
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 500, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 250, underlyingDecimals);

      await strategy.submitIntent();
      const [tokens, weights] = await vault.getIntent();
      expect(tokens.length).to.equal(4); // capped at n=4

      const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
      expect(total).to.equal(INTENT_SCALE);
    });

    // ── updateParameters ──────────────────────────────────────────────────────

    it("updateParameters: changes k for subsequent submitIntent calls", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 500, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 250, underlyingDecimals);

      // k=2 initially.
      await strategy.submitIntent();
      let [tokens] = await vault.getIntent();
      expect(tokens.length).to.equal(2);

      // Expand to k=3.
      await strategy.connect(owner).updateParameters(3);
      await strategy.submitIntent();
      [tokens] = await vault.getIntent();
      expect(tokens.length).to.equal(3);
    });

    it("updateParameters: reverts for non-owner", async function () {
      await expect(strategy.connect(stranger).updateParameters(5)).to.be.revertedWithCustomError(
        strategy,
        "OwnableUnauthorizedAccount",
      );
    });

    // ── Permissionlessness ────────────────────────────────────────────────────

    it("submitIntent is permissionless — any caller produces same result", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 500, underlyingDecimals);

      await strategy.connect(owner).submitIntent();
      const [tokens1, weights1] = await vault.getIntent();

      await strategy.connect(stranger).submitIntent();
      const [tokens2, weights2] = await vault.getIntent();

      expect(tokens1).to.deep.equal(tokens2);
      expect(weights1).to.deep.equal(weights2);
    });

    // ── Sum invariant ─────────────────────────────────────────────────────────

    it("sum invariant: always = 10^9 with and without APY data", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 7777, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 3333, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 1111, underlyingDecimals);

      for (const [k, hasApy] of [
        [1, false],
        [2, false],
        [3, false],
        [1, true],
        [2, true],
        [3, true],
      ] as [number, boolean][]) {
        if (hasApy) {
          await advancePastMinWindow();
          await strategy.submitIntent(); // baseline recorded at end of tx
          await advancePastMinWindow(); // elapsed >= MIN_WINDOW for APY vs that baseline
          await simulateGains(underlyingAsset, assetA, user, 100, underlyingDecimals);
          await simulateGains(underlyingAsset, assetB, user, 50, underlyingDecimals);
        }

        await strategy.connect(owner).updateParameters(k);
        await strategy.submitIntent();
        const [, weights] = await vault.getIntent();
        const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
        expect(total).to.equal(INTENT_SCALE, `sum must be 10^9 for k=${k}, hasApy=${hasApy}`);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // KBestApyStrategist — EqualWeighted mode
  // ═══════════════════════════════════════════════════════════════════════════

  describe("KBestApyStrategist (EqualWeighted)", function () {
    let strategy: KBestApyStrategist;
    let vault: OrionTransparentVault;

    beforeEach(async function () {
      const F = await ethers.getContractFactory("KBestApyStrategist");
      strategy = (await F.deploy(
        owner.address,
        await orionConfig.getAddress(),
        2,
        WEIGHTING_EQUAL,
      )) as unknown as KBestApyStrategist;
      await strategy.waitForDeployment();
      vault = await createVault(transparentVaultFactory, owner, await strategy.getAddress());
    });

    // ── Equal weight regardless of APY magnitude ──────────────────────────────

    it("k=2: both selected assets receive equal weight (5×10^8) despite different APYs", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 1000, underlyingDecimals);

      await strategy.submitIntent();
      await advancePastMinWindow();

      // assetA: 20% gain (higher APY), assetB: 10% gain — manager gives both equal weight.
      await simulateGains(underlyingAsset, assetA, user, 200, underlyingDecimals);
      await simulateGains(underlyingAsset, assetB, user, 100, underlyingDecimals);

      await strategy.submitIntent();
      const [, weights] = await vault.getIntent();
      expect(weights.length).to.equal(2);

      const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
      expect(total).to.equal(INTENT_SCALE);
      expect(BigInt(weights[0])).to.equal(500_000_000n);
      expect(BigInt(weights[1])).to.equal(500_000_000n);
    });

    it("k=3: 333_333_334 + 333_333_333 + 333_333_333 regardless of APY magnitudes", async function () {
      await strategy.connect(owner).updateParameters(3);

      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 1000, underlyingDecimals);

      await strategy.submitIntent();
      await advancePastMinWindow();

      // Wildly different gains — weights should still be equal.
      await simulateGains(underlyingAsset, assetA, user, 500, underlyingDecimals);
      await simulateGains(underlyingAsset, assetB, user, 100, underlyingDecimals);
      await simulateGains(underlyingAsset, assetC, user, 10, underlyingDecimals);

      await strategy.submitIntent();
      const [, weights] = await vault.getIntent();
      expect(weights.length).to.equal(3);

      const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
      expect(total).to.equal(INTENT_SCALE);

      // Residual (+1) goes to first position (highest APY).
      expect(BigInt(weights[0])).to.equal(333_333_334n);
      expect(BigInt(weights[1])).to.equal(333_333_333n);
      expect(BigInt(weights[2])).to.equal(333_333_333n);
    });

    // ── APY-driven selection ──────────────────────────────────────────────────

    it("APY ranking selects the highest-APY assets into the intent", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 1000, underlyingDecimals);

      await strategy.submitIntent();
      await advancePastMinWindow();

      // assetA and assetB have positive APY; assetC has none.
      await simulateGains(underlyingAsset, assetA, user, 200, underlyingDecimals);
      await simulateGains(underlyingAsset, assetB, user, 100, underlyingDecimals);

      // k=2: must include assetA and assetB, exclude assetC (APY = 0).
      await strategy.submitIntent();
      const [tokens] = await vault.getIntent();
      expect(tokens.length).to.equal(2);
      expect(tokens).to.include(await assetA.getAddress());
      expect(tokens).to.include(await assetB.getAddress());
      expect(tokens).to.not.include(await assetC.getAddress());
    });

    it("zero-APY fallback (no checkpoints): selects first k by config insertion order", async function () {
      // No checkpoints — all APYs = 0. Sentinel selection picks first k assets by index.
      await strategy.submitIntent();
      const [tokens, weights] = await vault.getIntent();
      expect(tokens.length).to.equal(2);

      const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
      expect(total).to.equal(INTENT_SCALE);
      // Equal weight since no APY data.
      expect(BigInt(weights[0])).to.equal(500_000_000n);
      expect(BigInt(weights[1])).to.equal(500_000_000n);
    });

    // ── k > n clamp ────────────────────────────────────────────────────────────

    it("k > n: clamps to n assets, sum = 10^9", async function () {
      await strategy.connect(owner).updateParameters(10); // n=4 whitelisted (underlying + 3 mocks)
      await strategy.submitIntent();

      const [tokens, weights] = await vault.getIntent();
      expect(tokens.length).to.equal(4);

      const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
      expect(total).to.equal(INTENT_SCALE);
    });

    // ── updateParameters ──────────────────────────────────────────────────────

    it("updateParameters changes selection size for next submitIntent", async function () {
      // k=2 initially.
      await strategy.submitIntent();
      let [tokens] = await vault.getIntent();
      expect(tokens.length).to.equal(2);

      await strategy.connect(owner).updateParameters(3);
      await strategy.submitIntent();
      [tokens] = await vault.getIntent();
      expect(tokens.length).to.equal(3);
    });

    it("updateParameters: reverts for non-owner", async function () {
      await expect(strategy.connect(stranger).updateParameters(1)).to.be.revertedWithCustomError(
        strategy,
        "OwnableUnauthorizedAccount",
      );
    });

    // ── Permissionlessness ────────────────────────────────────────────────────

    it("submitIntent is permissionless — any caller produces same result", async function () {
      await strategy.connect(owner).submitIntent();
      const [tokens1, weights1] = await vault.getIntent();

      await strategy.connect(stranger).submitIntent();
      const [tokens2, weights2] = await vault.getIntent();

      expect(tokens1).to.deep.equal(tokens2);
      expect(weights1).to.deep.equal(weights2);
    });

    // ── Sum invariant ─────────────────────────────────────────────────────────

    it("sum invariant: always = 10^9 for k=1,2,3 with and without APY data", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 500, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 250, underlyingDecimals);

      for (const k of [1, 2, 3]) {
        await strategy.connect(owner).updateParameters(k);
        await strategy.submitIntent();
        const [, weights] = await vault.getIntent();
        const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
        expect(total).to.equal(INTENT_SCALE, `sum must be 10^9 for k=${k}`);
      }
    });
  });
});
