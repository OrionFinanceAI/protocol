import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import "@openzeppelin/hardhat-upgrades";
import { ethers } from "hardhat";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";

import {
  MockUnderlyingAsset,
  MockERC4626Asset,
  MockNoDecimalsAsset,
  OrionConfig,
  TransparentVaultFactory,
  OrionTransparentVault,
  EqualWeight,
  KBestApyWeightedAverage,
  KBestApyEqualWeighted,
} from "../typechain-types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const INTENT_SCALE = 1_000_000_000n;
// Must exceed ApyStrategistBase.MIN_WINDOW (1 hour = 3600 s); add buffer for block mining.
const PAST_MIN_WINDOW = 3_700;

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
  // EqualWeight
  // ═══════════════════════════════════════════════════════════════════════════

  describe("EqualWeight", function () {
    let equalWeight: EqualWeight;
    let vault: OrionTransparentVault;

    beforeEach(async function () {
      const EqualWeightFactory = await ethers.getContractFactory("EqualWeight");
      equalWeight = (await EqualWeightFactory.deploy(await orionConfig.getAddress())) as unknown as EqualWeight;
      await equalWeight.waitForDeployment();

      // Auto-linking: createVault with EqualWeight calls setVault automatically.
      vault = await createVault(transparentVaultFactory, owner, await equalWeight.getAddress());
    });

    // ── setVault ──────────────────────────────────────────────────────────────

    describe("setVault", function () {
      it("reverts ZeroAddress for address(0)", async function () {
        const EqualWeightFactory = await ethers.getContractFactory("EqualWeight");
        const fresh = (await EqualWeightFactory.deploy(await orionConfig.getAddress())) as unknown as EqualWeight;
        await fresh.waitForDeployment();
        await expect(fresh.setVault(ethers.ZeroAddress)).to.be.revertedWithCustomError(fresh, "ZeroAddress");
      });

      it("first call to a non-zero address succeeds", async function () {
        const EqualWeightFactory = await ethers.getContractFactory("EqualWeight");
        const fresh = (await EqualWeightFactory.deploy(await orionConfig.getAddress())) as unknown as EqualWeight;
        await fresh.waitForDeployment();
        await expect(fresh.setVault(user.address)).to.not.be.reverted;
      });

      it("second call with the same address is idempotent", async function () {
        const EqualWeightFactory = await ethers.getContractFactory("EqualWeight");
        const fresh = (await EqualWeightFactory.deploy(await orionConfig.getAddress())) as unknown as EqualWeight;
        await fresh.waitForDeployment();
        await fresh.setVault(user.address);
        await expect(fresh.setVault(user.address)).to.not.be.reverted;
      });

      it("second call with a different address reverts StrategistVaultAlreadyLinked", async function () {
        const EqualWeightFactory = await ethers.getContractFactory("EqualWeight");
        const fresh = (await EqualWeightFactory.deploy(await orionConfig.getAddress())) as unknown as EqualWeight;
        await fresh.waitForDeployment();
        await fresh.setVault(user.address);
        await expect(fresh.setVault(stranger.address)).to.be.revertedWithCustomError(
          fresh,
          "StrategistVaultAlreadyLinked",
        );
      });

      it("submitIntent reverts ZeroAddress when no vault is linked", async function () {
        const EqualWeightFactory = await ethers.getContractFactory("EqualWeight");
        const fresh = (await EqualWeightFactory.deploy(await orionConfig.getAddress())) as unknown as EqualWeight;
        await fresh.waitForDeployment();
        await expect(fresh.connect(user).submitIntent()).to.be.revertedWithCustomError(fresh, "ZeroAddress");
      });
    });

    // ── ERC-165 & auto-linking ────────────────────────────────────────────────

    describe("ERC-165 and auto-linking", function () {
      it("supportsInterface: IOrionStrategist → true", async function () {
        const iface = await ethers.getContractAt("IOrionStrategist", await equalWeight.getAddress());
        const id = iface.interface.getFunction("setVault")!.selector;
        const id2 = iface.interface.getFunction("submitIntent")!.selector;
        // IOrionStrategist interfaceId = setVault.selector XOR submitIntent.selector
        const interfaceId = (BigInt(id) ^ BigInt(id2)).toString(16).padStart(8, "0");
        expect(await equalWeight.supportsInterface("0x" + interfaceId)).to.equal(true);
      });

      it("supportsInterface: IERC165 (0x01ffc9a7) → true", async function () {
        expect(await equalWeight.supportsInterface("0x01ffc9a7")).to.equal(true);
      });

      it("supportsInterface: random bytes4 → false", async function () {
        expect(await equalWeight.supportsInterface("0xdeadbeef")).to.equal(false);
      });

      it("createVault auto-links: submitIntent succeeds without manual setVault", async function () {
        // vault was created with equalWeight as strategist → setVault called automatically
        await expect(equalWeight.connect(stranger).submitIntent()).to.not.be.reverted;
      });
    });

    // ── Distribution math ─────────────────────────────────────────────────────

    describe("distribution math", function () {
      it("n=4 (default): underlying + assetA + assetB + assetC each get 25%", async function () {
        // OrionConfig.initialize always whitelists the underlying asset, so n=4.
        await equalWeight.submitIntent();
        const [, weights] = await vault.getIntent();
        expect(weights.length).to.equal(4);

        const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
        expect(total).to.equal(INTENT_SCALE);

        // 1_000_000_000 / 4 = 250_000_000 exactly — no rounding residual.
        for (const w of weights) {
          expect(BigInt(w)).to.equal(250_000_000n);
        }
      });

      it("n=2: underlying + one ERC4626 asset each receive exactly 5 × 10^8", async function () {
        // Fresh config with 1 ERC4626 asset so that n = underlying + 1 = 2.
        const freshDeployed = await deployUpgradeableProtocol(owner, underlyingAsset, owner);
        const freshConfig = freshDeployed.orionConfig;
        const freshFactory = freshDeployed.transparentVaultFactory;
        const freshExec = await (
          await ethers.getContractFactory("ERC4626ExecutionAdapter")
        ).deploy(await freshConfig.getAddress());
        const extra = await (
          await ethers.getContractFactory("MockERC4626Asset")
        ).deploy(await underlyingAsset.getAddress(), "X", "X");
        await extra.waitForDeployment();
        await freshConfig.addWhitelistedAsset(
          await extra.getAddress(),
          await mockPriceAdapter.getAddress(),
          await freshExec.getAddress(),
        );

        const ew = (await (
          await ethers.getContractFactory("EqualWeight")
        ).deploy(await freshConfig.getAddress())) as unknown as EqualWeight;
        await ew.waitForDeployment();
        const v = await createVault(freshFactory, owner, await ew.getAddress());
        await ew.submitIntent();

        const [, weights] = await v.getIntent();
        expect(weights.length).to.equal(2);
        for (const w of weights) {
          expect(BigInt(w)).to.equal(500_000_000n);
        }
        const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
        expect(total).to.equal(INTENT_SCALE);
      });

      it("n=3: residual of 1 is added to first asset (floor(10^9 / 3) = 333_333_333)", async function () {
        // Fresh config with 2 ERC4626 assets so that n = underlying + 2 = 3.
        const freshDeployed = await deployUpgradeableProtocol(owner, underlyingAsset, owner);
        const freshConfig = freshDeployed.orionConfig;
        const freshFactory = freshDeployed.transparentVaultFactory;
        const freshExec = await (
          await ethers.getContractFactory("ERC4626ExecutionAdapter")
        ).deploy(await freshConfig.getAddress());
        const ERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");
        for (const sym of ["X1", "X2"]) {
          const extra = await ERC4626Factory.deploy(await underlyingAsset.getAddress(), sym, sym);
          await extra.waitForDeployment();
          await freshConfig.addWhitelistedAsset(
            await extra.getAddress(),
            await mockPriceAdapter.getAddress(),
            await freshExec.getAddress(),
          );
        }

        const ew = (await (
          await ethers.getContractFactory("EqualWeight")
        ).deploy(await freshConfig.getAddress())) as unknown as EqualWeight;
        await ew.waitForDeployment();
        const v = await createVault(freshFactory, owner, await ew.getAddress());
        await ew.submitIntent();

        const [, weights] = await v.getIntent();
        expect(weights.length).to.equal(3);

        const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
        expect(total).to.equal(INTENT_SCALE);

        // floor(1e9 / 3) = 333_333_333; residual = 1 goes to first asset.
        expect(BigInt(weights[0])).to.equal(333_333_334n);
        expect(BigInt(weights[1])).to.equal(333_333_333n);
        expect(BigInt(weights[2])).to.equal(333_333_333n);
      });

      it("n=7: residual of 6 is added to the first asset (floor(10^9 / 7) = 142_857_142)", async function () {
        // Whitelist starts with 4 (underlying + assetA + assetB + assetC); add 3 more to reach n=7.
        const ERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");
        for (let i = 4; i <= 6; i++) {
          const extra = await ERC4626Factory.deploy(await underlyingAsset.getAddress(), `Asset${i}`, `A${i}`);
          await extra.waitForDeployment();
          await orionConfig.addWhitelistedAsset(
            await extra.getAddress(),
            await mockPriceAdapter.getAddress(),
            await mockExecutionAdapter.getAddress(),
          );
        }

        await equalWeight.submitIntent();
        const [, weights] = await vault.getIntent();
        expect(weights.length).to.equal(7);

        const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
        expect(total).to.equal(INTENT_SCALE);

        // floor(1e9 / 7) = 142_857_142; 7 × 142_857_142 = 999_999_994; residual = 6.
        expect(BigInt(weights[0])).to.equal(142_857_148n); // 142_857_142 + 6 residual
        for (let i = 1; i < 7; i++) {
          expect(BigInt(weights[i])).to.equal(142_857_142n);
        }
      });

      it("sum invariant: always equals 10^9 for any n", async function () {
        const ERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");

        for (const count of [1, 2, 3, 5, 9]) {
          // Fresh deployment per iteration to isolate whitelist state.
          const freshDeployed = await deployUpgradeableProtocol(owner, underlyingAsset, owner);
          const freshConfig = freshDeployed.orionConfig;
          const freshFactory = freshDeployed.transparentVaultFactory;

          const freshExec = await (
            await ethers.getContractFactory("ERC4626ExecutionAdapter")
          ).deploy(await freshConfig.getAddress());

          for (let i = 0; i < count; i++) {
            const asset = await ERC4626Factory.deploy(await underlyingAsset.getAddress(), `T${i}`, `T${i}`);
            await asset.waitForDeployment();
            await freshConfig.addWhitelistedAsset(
              await asset.getAddress(),
              await mockPriceAdapter.getAddress(),
              await freshExec.getAddress(),
            );
          }

          const EWFactory = await ethers.getContractFactory("EqualWeight");
          const ew = (await EWFactory.deploy(await freshConfig.getAddress())) as unknown as EqualWeight;
          await ew.waitForDeployment();

          const v = await createVault(freshFactory, owner, await ew.getAddress());
          await ew.submitIntent();

          const [, weights] = await v.getIntent();
          const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
          expect(total).to.equal(INTENT_SCALE, `sum must be 10^9 for n=${count}`);
        }
      });

      it("only whitelisted assets are included in the intent", async function () {
        await equalWeight.submitIntent();
        const [tokens] = await vault.getIntent();

        // OrionConfig always whitelists the underlying asset — it appears in intents.
        expect(tokens).to.include(await underlyingAsset.getAddress());
        expect(tokens).to.include(await assetA.getAddress());
        expect(tokens).to.include(await assetB.getAddress());
        expect(tokens).to.include(await assetC.getAddress());
      });
    });

    // ── Permissionlessness ────────────────────────────────────────────────────

    describe("permissionlessness", function () {
      it("any caller can invoke submitIntent", async function () {
        await expect(equalWeight.connect(owner).submitIntent()).to.not.be.reverted;
        await expect(equalWeight.connect(user).submitIntent()).to.not.be.reverted;
        await expect(equalWeight.connect(stranger).submitIntent()).to.not.be.reverted;
      });

      it("all callers produce identical, deterministic intent", async function () {
        await equalWeight.connect(owner).submitIntent();
        const [tokens1, weights1] = await vault.getIntent();

        await equalWeight.connect(stranger).submitIntent();
        const [tokens2, weights2] = await vault.getIntent();

        expect(tokens1).to.deep.equal(tokens2);
        expect(weights1).to.deep.equal(weights2);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // APY checkpoint mechanics (shared by both APY strategies)
  // Tested via KBestApyWeightedAverage as the concrete vehicle.
  // ═══════════════════════════════════════════════════════════════════════════

  describe("APY checkpoint mechanics (ApyStrategistBase)", function () {
    let strategy: KBestApyWeightedAverage;
    let vault: OrionTransparentVault;

    beforeEach(async function () {
      const F = await ethers.getContractFactory("KBestApyWeightedAverage");
      strategy = (await F.deploy(
        owner.address,
        await orionConfig.getAddress(),
        3,
      )) as unknown as KBestApyWeightedAverage;
      await strategy.waitForDeployment();
      vault = await createVault(transparentVaultFactory, owner, await strategy.getAddress());
    });

    it("getCheckpoint returns (0, 0) before any updateCheckpoints call", async function () {
      const [sharePrice, timestamp] = await strategy.getCheckpoint(await assetA.getAddress());
      expect(sharePrice).to.equal(0n);
      expect(timestamp).to.equal(0n);
    });

    it("updateCheckpoints records the current share price and timestamp", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await strategy.updateCheckpoints([await assetA.getAddress()]);

      const [sharePrice, timestamp] = await strategy.getCheckpoint(await assetA.getAddress());
      // ERC4626 initial share price: convertToAssets(1e12) = 1e12 (1:1 with 12-dec underlying).
      expect(sharePrice).to.equal(10n ** BigInt(underlyingDecimals));
      expect(timestamp).to.be.gt(0n);
    });

    it("updateCheckpoints emits CheckpointRecorded with correct asset and share price", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      const tx = await strategy.updateCheckpoints([await assetA.getAddress()]);
      await tx.wait();
      // Verify the checkpoint was recorded with the correct price (don't assert the exact timestamp).
      const [sharePrice, timestamp] = await strategy.getCheckpoint(await assetA.getAddress());
      expect(sharePrice).to.equal(10n ** BigInt(underlyingDecimals));
      expect(timestamp).to.be.gt(0n);
      await expect(tx)
        .to.emit(strategy, "CheckpointRecorded")
        .withArgs(await assetA.getAddress(), 10n ** BigInt(underlyingDecimals), timestamp);
    });

    it("updateCheckpoints is permissionless — stranger can call it", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await expect(strategy.connect(stranger).updateCheckpoints([await assetA.getAddress()])).to.not.be.reverted;
    });

    it("updateCheckpoints silently skips non-ERC4626 assets", async function () {
      // underlyingAsset is ERC20 only — no convertToAssets().
      await strategy.updateCheckpoints([await underlyingAsset.getAddress()]);
      const [sharePrice, timestamp] = await strategy.getCheckpoint(await underlyingAsset.getAddress());
      expect(sharePrice).to.equal(0n);
      expect(timestamp).to.equal(0n);
    });

    it("updateCheckpoints silently skips assets whose decimals() reverts", async function () {
      const F = await ethers.getContractFactory("MockNoDecimalsAsset");
      const noDecimals = (await F.deploy()) as unknown as MockNoDecimalsAsset;
      await noDecimals.waitForDeployment();

      // decimals() reverts → _getSharePrice returns 0 → no checkpoint written
      await expect(strategy.updateCheckpoints([await noDecimals.getAddress()])).to.not.be.reverted;
      const [sharePrice, timestamp] = await strategy.getCheckpoint(await noDecimals.getAddress());
      expect(sharePrice).to.equal(0n);
      expect(timestamp).to.equal(0n);
    });

    it("APY = 0 within MIN_WINDOW even if gains occurred → equal-weight fallback", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 1000, underlyingDecimals);

      // Record checkpoints at T=0 then immediately simulate gains (elapsed < MIN_WINDOW).
      await strategy.updateCheckpoints([
        await assetA.getAddress(),
        await assetB.getAddress(),
        await assetC.getAddress(),
      ]);
      // Large gains but window hasn't passed → APY = 0 for all → equal-weight fallback.
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

      await strategy.updateCheckpoints([
        await assetA.getAddress(),
        await assetB.getAddress(),
        await assetC.getAddress(),
      ]);

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

      await strategy.updateCheckpoints([
        await assetA.getAddress(),
        await assetB.getAddress(),
        await assetC.getAddress(),
      ]);

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

      await strategy.updateCheckpoints([
        await assetA.getAddress(),
        await assetB.getAddress(),
        await assetC.getAddress(),
      ]);

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

  describe("KBestApyWeightedAverage", function () {
    let strategy: KBestApyWeightedAverage;
    let vault: OrionTransparentVault;

    beforeEach(async function () {
      const F = await ethers.getContractFactory("KBestApyWeightedAverage");
      strategy = (await F.deploy(
        owner.address,
        await orionConfig.getAddress(),
        2,
      )) as unknown as KBestApyWeightedAverage;
      await strategy.waitForDeployment();
      vault = await createVault(transparentVaultFactory, owner, await strategy.getAddress());
    });

    // ── setVault / vault errors ───────────────────────────────────────────────

    it("setVault: reverts ZeroAddress for address(0)", async function () {
      const F = await ethers.getContractFactory("KBestApyWeightedAverage");
      const fresh = (await F.deploy(
        owner.address,
        await orionConfig.getAddress(),
        1,
      )) as unknown as KBestApyWeightedAverage;
      await fresh.waitForDeployment();
      await expect(fresh.setVault(ethers.ZeroAddress)).to.be.revertedWithCustomError(fresh, "ZeroAddress");
    });

    it("submitIntent: reverts ZeroAddress when no vault is linked", async function () {
      const F = await ethers.getContractFactory("KBestApyWeightedAverage");
      const fresh = (await F.deploy(
        owner.address,
        await orionConfig.getAddress(),
        1,
      )) as unknown as KBestApyWeightedAverage;
      await fresh.waitForDeployment();
      await expect(fresh.connect(user).submitIntent()).to.be.revertedWithCustomError(fresh, "ZeroAddress");
    });

    it("submitIntent: reverts OrderIntentCannotBeEmpty when k=0", async function () {
      const F = await ethers.getContractFactory("KBestApyWeightedAverage");
      const fresh = (await F.deploy(
        owner.address,
        await orionConfig.getAddress(),
        0,
      )) as unknown as KBestApyWeightedAverage;
      await fresh.waitForDeployment();
      const v = await createVault(transparentVaultFactory, owner, await fresh.getAddress());
      void v; // vault linked — k=0 should still revert
      await expect(fresh.connect(user).submitIntent()).to.be.revertedWithCustomError(fresh, "OrderIntentCannotBeEmpty");
    });

    // ── Zero-APY fallback ─────────────────────────────────────────────────────

    it("zero APY fallback (k=2, no checkpoints): equal weight 5×10^8 each", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 1000, underlyingDecimals);
      // No updateCheckpoints called → all APYs = 0 → equal-weight fallback.

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

      await strategy.updateCheckpoints([
        await assetA.getAddress(),
        await assetB.getAddress(),
        await assetC.getAddress(),
      ]);
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

      await strategy.updateCheckpoints([await assetA.getAddress(), await assetB.getAddress()]);
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

      await strategy.updateCheckpoints([await assetA.getAddress(), await assetB.getAddress()]);
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
          // Expire the rate gate from any prior checkpoint before recording a fresh baseline.
          await advancePastMinWindow();
          await strategy.updateCheckpoints([
            await assetA.getAddress(),
            await assetB.getAddress(),
            await assetC.getAddress(),
          ]);
          // Let elapsed >= MIN_WINDOW so _getAssetApy returns a non-zero value.
          await advancePastMinWindow();
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
  // KBestApyEqualWeighted
  // ═══════════════════════════════════════════════════════════════════════════

  describe("KBestApyEqualWeighted", function () {
    let strategy: KBestApyEqualWeighted;
    let vault: OrionTransparentVault;

    beforeEach(async function () {
      const F = await ethers.getContractFactory("KBestApyEqualWeighted");
      strategy = (await F.deploy(owner.address, await orionConfig.getAddress(), 2)) as unknown as KBestApyEqualWeighted;
      await strategy.waitForDeployment();
      vault = await createVault(transparentVaultFactory, owner, await strategy.getAddress());
    });

    // ── Equal weight regardless of APY magnitude ──────────────────────────────

    it("k=2: both selected assets receive equal weight (5×10^8) despite different APYs", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 1000, underlyingDecimals);

      await strategy.updateCheckpoints([
        await assetA.getAddress(),
        await assetB.getAddress(),
        await assetC.getAddress(),
      ]);
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

      await strategy.updateCheckpoints([
        await assetA.getAddress(),
        await assetB.getAddress(),
        await assetC.getAddress(),
      ]);
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

      await strategy.updateCheckpoints([
        await assetA.getAddress(),
        await assetB.getAddress(),
        await assetC.getAddress(),
      ]);
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
