import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "./helpers/hh";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";

import type {
  MockUnderlyingAsset,
  MockERC4626Asset,
  OrionConfig,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  OrionTransparentVault,
  KBestTvlWeightedAverage,
  MockNonERC165Contract,
  MockERC165NonStrategist,
} from "../typechain-types";

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

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("Strategist Linking", function () {
  let owner: SignerWithAddress;
  let user: SignerWithAddress;
  let stranger: SignerWithAddress;

  let orionConfig: OrionConfig;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let transparentVaultFactory: TransparentVaultFactory;
  let underlyingAsset: MockUnderlyingAsset;
  let underlyingDecimals: number;

  let mockPriceAdapter: { getAddress(): Promise<string> };
  let mockExecutionAdapter: { getAddress(): Promise<string> };

  // Shared ERC4626 mock assets used across suites
  let assetA: MockERC4626Asset;
  let assetB: MockERC4626Asset;
  let assetC: MockERC4626Asset;

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    this.timeout(90_000);
    [owner, , user, stranger] = await ethers.getSigners();

    // 12-decimal underlying (matches PassiveStrategist test)
    const UnderlyingFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    underlyingAsset = (await UnderlyingFactory.deploy(12)) as unknown as MockUnderlyingAsset;
    await underlyingAsset.waitForDeployment();
    underlyingDecimals = 12;

    const deployed = await deployUpgradeableProtocol(owner, underlyingAsset, owner);
    orionConfig = deployed.orionConfig;
    liquidityOrchestrator = deployed.liquidityOrchestrator;
    transparentVaultFactory = deployed.transparentVaultFactory;

    await liquidityOrchestrator.setTargetBufferRatio(100);
    await liquidityOrchestrator.setSlippageTolerance(50);

    // Deploy reusable adapters
    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    mockPriceAdapter = await MockPriceAdapterFactory.deploy();

    const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
    mockExecutionAdapter = await ERC4626ExecutionAdapterFactory.deploy(await orionConfig.getAddress());

    // Deploy three ERC4626 mock assets
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

    // Whitelist all three
    for (const asset of [assetA, assetB, assetC]) {
      await orionConfig.addWhitelistedAsset(
        await asset.getAddress(),
        await mockPriceAdapter.getAddress(),
        await mockExecutionAdapter.getAddress(),
      );
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Auto-linking on vault assignment
  // ───────────────────────────────────────────────────────────────────────────

  describe("Auto-linking on strategist assignment", function () {
    it("EOA strategist: assignment succeeds, vault.strategist() is correct", async function () {
      const vault = await createVault(transparentVaultFactory, owner, user.address);
      expect(await vault.strategist()).to.equal(user.address);
    });

    it("Non-ERC165 contract: assignment succeeds, no revert, no setVault side-effect", async function () {
      const MockNonERC165Factory = await ethers.getContractFactory("MockNonERC165Contract");
      const contract = (await MockNonERC165Factory.deploy()) as unknown as MockNonERC165Contract;
      await contract.waitForDeployment();

      // Vault creation with non-ERC165 contract as initial strategist must not revert
      const vault = await createVault(transparentVaultFactory, owner, await contract.getAddress());
      expect(await vault.strategist()).to.equal(await contract.getAddress());

      // updateStrategist to the same contract must also not revert
      await expect(vault.connect(owner).updateStrategist(await contract.getAddress())).to.not.be.rejected;
      expect(await vault.strategist()).to.equal(await contract.getAddress());
    });

    it("ERC165 non-IOrionStrategist (SAFE-like): assignment succeeds, no setVault call", async function () {
      const MockERC165Factory = await ethers.getContractFactory("MockERC165NonStrategist");
      const safelike = (await MockERC165Factory.deploy()) as unknown as MockERC165NonStrategist;
      await safelike.waitForDeployment();

      const vault = await createVault(transparentVaultFactory, owner, await safelike.getAddress());
      expect(await vault.strategist()).to.equal(await safelike.getAddress());
    });

    it("IOrionStrategist: setVault called automatically — strategy.submitIntent() succeeds", async function () {
      // Fresh strategy without any vault linked
      const StrategyFactory = await ethers.getContractFactory("KBestTvlWeightedAverage");
      const strategy = (await StrategyFactory.deploy(
        owner.address,
        await orionConfig.getAddress(),
        2,
      )) as unknown as KBestTvlWeightedAverage;
      await strategy.waitForDeployment();

      // Deposit TVL so submitIntent produces a valid non-empty intent
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 500, underlyingDecimals);

      const vault = await createVault(transparentVaultFactory, owner, owner.address);
      await vault.connect(owner).updateStrategist(await strategy.getAddress());

      // setVault was called automatically — submitIntent should not revert
      await expect(strategy.connect(user).submitIntent()).to.not.be.rejected;

      const [tokens] = await vault.getIntent();
      expect(tokens.length).to.equal(2);
    });

    it("IOrionStrategist passed to createVault() directly: initialize-time linking works", async function () {
      // Fresh strategy, no vault linked yet
      const StrategyFactory = await ethers.getContractFactory("KBestTvlWeightedAverage");
      const strategy = (await StrategyFactory.deploy(
        owner.address,
        await orionConfig.getAddress(),
        2,
      )) as unknown as KBestTvlWeightedAverage;
      await strategy.waitForDeployment();

      // Deposit TVL so submitIntent produces a valid non-empty intent
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 500, underlyingDecimals);

      // Pass strategy as initial strategist — no updateStrategist() call
      const vault = await createVault(transparentVaultFactory, owner, await strategy.getAddress());

      expect(await vault.strategist()).to.equal(await strategy.getAddress());

      // setVault was called during initialize — submitIntent should not revert
      await expect(strategy.connect(user).submitIntent()).to.not.be.rejected;

      const [tokens] = await vault.getIntent();
      expect(tokens.length).to.equal(2);
    });

    it("IOrionStrategist already linked to a different vault: updateStrategist reverts", async function () {
      const StrategyFactory = await ethers.getContractFactory("KBestTvlWeightedAverage");
      const strategy = (await StrategyFactory.deploy(
        owner.address,
        await orionConfig.getAddress(),
        1,
      )) as unknown as KBestTvlWeightedAverage;
      await strategy.waitForDeployment();

      // Link strategy to vault1
      const vault1 = await createVault(transparentVaultFactory, owner, owner.address);
      await vault1.connect(owner).updateStrategist(await strategy.getAddress());

      // Try to assign same strategy instance to vault2 — setVault should reject it
      const vault2 = await createVault(transparentVaultFactory, owner, owner.address);
      await expect(vault2.connect(owner).updateStrategist(await strategy.getAddress())).to.be.revertedWithCustomError(
        strategy,
        "StrategistVaultAlreadyLinked",
      );
    });

    it("Re-assigning same IOrionStrategist to same vault is idempotent", async function () {
      const StrategyFactory = await ethers.getContractFactory("KBestTvlWeightedAverage");
      const strategy = (await StrategyFactory.deploy(
        owner.address,
        await orionConfig.getAddress(),
        1,
      )) as unknown as KBestTvlWeightedAverage;
      await strategy.waitForDeployment();

      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);

      const vault = await createVault(transparentVaultFactory, owner, owner.address);
      await vault.connect(owner).updateStrategist(await strategy.getAddress());

      // Second updateStrategist with the SAME strategy on the SAME vault — must not revert
      await expect(vault.connect(owner).updateStrategist(await strategy.getAddress())).to.not.be.rejected;
      expect(await vault.strategist()).to.equal(await strategy.getAddress());
    });

    it("Switching IOrionStrategist to EOA: EOA can submit intent directly, old strategy is blocked", async function () {
      const StrategyFactory = await ethers.getContractFactory("KBestTvlWeightedAverage");
      const strategy = (await StrategyFactory.deploy(
        owner.address,
        await orionConfig.getAddress(),
        1,
      )) as unknown as KBestTvlWeightedAverage;
      await strategy.waitForDeployment();

      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);

      const vault = await createVault(transparentVaultFactory, owner, owner.address);
      await vault.connect(owner).updateStrategist(await strategy.getAddress());

      // Switch to EOA strategist
      await vault.connect(owner).updateStrategist(user.address);
      expect(await vault.strategist()).to.equal(user.address);

      // Old strategy can no longer submit intent to this vault (not the strategist anymore)
      // strategy.submitIntent() will call vault.submitIntent(intent) but msg.sender = strategy
      // which is no longer vault.strategist() — should revert with NotAuthorized
      await expect(strategy.connect(owner).submitIntent()).to.be.revertedWithCustomError(vault, "NotAuthorized");

      // EOA can submit directly
      const intent = [{ token: await assetA.getAddress(), weight: 1_000_000_000n }];
      await expect(vault.connect(user).submitIntent(intent)).to.not.be.rejected;
    });

    it("Rotating from strategyA to strategyB: vault links to B, A is detached", async function () {
      const StrategyFactory = await ethers.getContractFactory("KBestTvlWeightedAverage");
      const strategyA = (await StrategyFactory.deploy(
        owner.address,
        await orionConfig.getAddress(),
        1,
      )) as unknown as KBestTvlWeightedAverage;
      const strategyB = (await StrategyFactory.deploy(
        owner.address,
        await orionConfig.getAddress(),
        2,
      )) as unknown as KBestTvlWeightedAverage;
      await Promise.all([strategyA.waitForDeployment(), strategyB.waitForDeployment()]);

      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 500, underlyingDecimals);

      const vault = await createVault(transparentVaultFactory, owner, owner.address);
      await vault.connect(owner).updateStrategist(await strategyA.getAddress());
      await vault.connect(owner).updateStrategist(await strategyB.getAddress());

      expect(await vault.strategist()).to.equal(await strategyB.getAddress());

      // strategyB is linked and can submit
      await expect(strategyB.connect(user).submitIntent()).to.not.be.rejected;

      // strategyA is no longer the strategist — its submitIntent is blocked by onlyStrategist
      await expect(strategyA.connect(user).submitIntent()).to.be.revertedWithCustomError(vault, "NotAuthorized");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. setVault direct behaviour
  // ───────────────────────────────────────────────────────────────────────────

  describe("setVault", function () {
    let strategy: KBestTvlWeightedAverage;

    beforeEach(async function () {
      const StrategyFactory = await ethers.getContractFactory("KBestTvlWeightedAverage");
      strategy = (await StrategyFactory.deploy(
        owner.address,
        await orionConfig.getAddress(),
        1,
      )) as unknown as KBestTvlWeightedAverage;
      await strategy.waitForDeployment();
    });

    it("Reverts with ZeroAddress when vault_ is address(0)", async function () {
      await expect(strategy.setVault(ethers.ZeroAddress)).to.be.revertedWithCustomError(strategy, "ZeroAddress");
    });

    it("First call to a non-zero address succeeds", async function () {
      await expect(strategy.setVault(user.address)).to.not.be.rejected;
    });

    it("Second call with the same address is idempotent — no revert", async function () {
      await strategy.setVault(user.address);
      await expect(strategy.setVault(user.address)).to.not.be.rejected;
    });

    it("Second call with a different address reverts with StrategistVaultAlreadyLinked", async function () {
      await strategy.setVault(user.address);
      await expect(strategy.setVault(stranger.address)).to.be.revertedWithCustomError(
        strategy,
        "StrategistVaultAlreadyLinked",
      );
    });

    it("submitIntent reverts with ZeroAddress when no vault has been linked", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      // strategy._vault is still address(0)
      await expect(strategy.connect(user).submitIntent()).to.be.revertedWithCustomError(strategy, "ZeroAddress");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. submitIntent permissionlessness
  // ───────────────────────────────────────────────────────────────────────────

  describe("submitIntent permissionlessness", function () {
    let strategy: KBestTvlWeightedAverage;
    let vault: OrionTransparentVault;

    beforeEach(async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 6000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 3000, underlyingDecimals);

      const StrategyFactory = await ethers.getContractFactory("KBestTvlWeightedAverage");
      strategy = (await StrategyFactory.deploy(
        owner.address,
        await orionConfig.getAddress(),
        2,
      )) as unknown as KBestTvlWeightedAverage;
      await strategy.waitForDeployment();

      vault = await createVault(transparentVaultFactory, owner, owner.address);
      await vault.connect(owner).updateStrategist(await strategy.getAddress());
    });

    it("Owner can call submitIntent", async function () {
      await expect(strategy.connect(owner).submitIntent()).to.not.be.rejected;
    });

    it("Any random address can call submitIntent", async function () {
      await expect(strategy.connect(stranger).submitIntent()).to.not.be.rejected;
    });

    it("Both callers produce identical intent — output is deterministic", async function () {
      await strategy.connect(owner).submitIntent();
      const [tokens1, weights1] = await vault.getIntent();

      // Submit again from a different caller — same onchain state → same result
      await strategy.connect(stranger).submitIntent();
      const [tokens2, weights2] = await vault.getIntent();

      expect(tokens1).to.deep.equal(tokens2);
      expect(weights1).to.deep.equal(weights2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. 9-decimal weight math
  // ───────────────────────────────────────────────────────────────────────────

  describe("9-decimal weight math (intentScale = 10^9)", function () {
    const INTENT_SCALE = 1_000_000_000n;

    async function deployAndLink(
      k: number,
      vaultOwner: SignerWithAddress,
    ): Promise<{
      strategy: KBestTvlWeightedAverage;
      vault: OrionTransparentVault;
    }> {
      const StrategyFactory = await ethers.getContractFactory("KBestTvlWeightedAverage");
      const strategy = (await StrategyFactory.deploy(
        vaultOwner.address,
        await orionConfig.getAddress(),
        k,
      )) as unknown as KBestTvlWeightedAverage;
      await strategy.waitForDeployment();

      const vault = await createVault(transparentVaultFactory, vaultOwner, vaultOwner.address);
      await vault.connect(vaultOwner).updateStrategist(await strategy.getAddress());
      return { strategy, vault };
    }

    it("k=1: single winner receives exactly 10^9", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 6000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 3000, underlyingDecimals);

      const { strategy, vault } = await deployAndLink(1, owner);
      await strategy.submitIntent();

      const [tokens, weights] = await vault.getIntent();
      expect(tokens.length).to.equal(1);
      expect(weights[0]).to.equal(INTENT_SCALE);
      expect(tokens[0]).to.equal(await assetA.getAddress()); // highest TVL wins
    });

    it("k=2, equal TVL (1:1): each asset gets exactly 500_000_000", async function () {
      // Both assets same deposit amount
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 1000, underlyingDecimals);

      const { strategy, vault } = await deployAndLink(2, owner);
      await strategy.submitIntent();

      const [tokens, weights] = await vault.getIntent();
      expect(tokens.length).to.equal(2);

      const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
      expect(total).to.equal(INTENT_SCALE);
      for (const w of weights) {
        expect(BigInt(w)).to.equal(500_000_000n);
      }
    });

    it("k=2, 2:1 TVL ratio: residual assigned to highest-TVL asset, sum = 10^9", async function () {
      // A=2000, B=1000 → total=3000
      // A: floor(2/3 * 1e9) = 666_666_666
      // B: floor(1/3 * 1e9) = 333_333_333  sum = 999_999_999 → residual +1 → A = 666_666_667
      await mintAndDeposit(underlyingAsset, assetA, user, 2000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 1000, underlyingDecimals);

      const { strategy, vault } = await deployAndLink(2, owner);
      await strategy.submitIntent();

      const [tokens, weights] = await vault.getIntent();
      expect(tokens.length).to.equal(2);

      const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
      expect(total).to.equal(INTENT_SCALE);

      // Highest-TVL asset is tokens[0] and receives the residual
      expect(tokens[0]).to.equal(await assetA.getAddress());
      expect(BigInt(weights[0])).to.equal(666_666_667n); // 666_666_666 + 1 residual
      expect(BigInt(weights[1])).to.equal(333_333_333n);
    });

    it("k=3, 6:3:1 TVL ratio: exact division, no residual needed, sum = 10^9", async function () {
      // A=6000, B=3000, C=1000, total=10000
      // A: 6000/10000 * 1e9 = 600_000_000 (exact)
      // B: 3000/10000 * 1e9 = 300_000_000 (exact)
      // C: 1000/10000 * 1e9 = 100_000_000 (exact)
      // sum = 1_000_000_000 → no residual
      await mintAndDeposit(underlyingAsset, assetA, user, 6000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 3000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 1000, underlyingDecimals);

      const { strategy, vault } = await deployAndLink(3, owner);
      await strategy.submitIntent();

      const [tokens, weights] = await vault.getIntent();
      expect(tokens.length).to.equal(3);

      const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
      expect(total).to.equal(INTENT_SCALE);

      // Verify order (highest TVL first) and exact weights
      expect(tokens[0]).to.equal(await assetA.getAddress());
      expect(tokens[1]).to.equal(await assetB.getAddress());
      expect(tokens[2]).to.equal(await assetC.getAddress());
      expect(BigInt(weights[0])).to.equal(600_000_000n);
      expect(BigInt(weights[1])).to.equal(300_000_000n);
      expect(BigInt(weights[2])).to.equal(100_000_000n);
    });

    it("k=3, equal TVL: each gets exactly 333_333_334 + 333_333_333 + 333_333_333 = 10^9", async function () {
      // Three equal TVLs → each = floor(1/3 * 1e9) = 333_333_333
      // sum = 999_999_999 → residual 1 → tokens[0] gets 333_333_334
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 1000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 1000, underlyingDecimals);

      const { strategy, vault } = await deployAndLink(3, owner);
      await strategy.submitIntent();

      const [_tokens, weights] = await vault.getIntent();
      const total = weights.reduce((acc, w) => acc + BigInt(w), 0n);
      expect(total).to.equal(INTENT_SCALE);

      // First asset (tiebreak → insertion order) gets the +1 residual
      expect(BigInt(weights[0])).to.equal(333_333_334n);
      expect(BigInt(weights[1])).to.equal(333_333_333n);
      expect(BigInt(weights[2])).to.equal(333_333_333n);
    });

    it("Non-ERC4626 assets (underlying USDC) get dust TVL and lose to ERC4626 vaults", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 1000, underlyingDecimals);

      const { strategy, vault } = await deployAndLink(1, owner);
      await strategy.submitIntent();

      const [tokens] = await vault.getIntent();
      expect(tokens[0]).to.equal(await assetA.getAddress());
      expect(tokens).to.not.include(await underlyingAsset.getAddress());
    });

    it("updateParameters(k) changes the selection in the next submitIntent call", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 6000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 3000, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 1000, underlyingDecimals);

      const { strategy, vault } = await deployAndLink(1, owner);
      await strategy.submitIntent();

      let [tokens] = await vault.getIntent();
      expect(tokens.length).to.equal(1);
      expect(tokens[0]).to.equal(await assetA.getAddress());

      // Expand to k=3
      await strategy.connect(owner).updateParameters(3);
      await strategy.submitIntent();

      [tokens] = await vault.getIntent();
      expect(tokens.length).to.equal(3);
      expect(tokens).to.include(await assetA.getAddress());
      expect(tokens).to.include(await assetB.getAddress());
      expect(tokens).to.include(await assetC.getAddress());
    });

    it("Sum is always exactly 10^9 across arbitrary k values", async function () {
      await mintAndDeposit(underlyingAsset, assetA, user, 7777, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetB, user, 3333, underlyingDecimals);
      await mintAndDeposit(underlyingAsset, assetC, user, 1111, underlyingDecimals);

      const { strategy, vault } = await deployAndLink(1, owner);

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
