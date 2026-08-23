import { expect } from "chai";
import { networkHelpers } from "./helpers/hh";
import { ethers } from "./helpers/hh";
import { deployUUPSProxy } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";
import { hashProtocolState, pendingRedeemsHash } from "./helpers/protocolStateHash";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  LiquidityOrchestratorCommitmentHarness,
  MockExecutionAdapter,
  MockPriceAdapter,
  MockSP1Verifier,
  MockUnderlyingAsset,
  OrionConfig,
  OrionTransparentVault,
  PriceAdapterRegistry,
  TransparentVaultFactory,
  UpgradeableBeacon,
} from "../typechain-types";

const PHASE_STATE_COMMITMENT = 1;
const PHASE_SELLING = 2;

async function impersonate(address: string) {
  await networkHelpers.impersonateAccount(address);
  await networkHelpers.setBalance(address, ethers.parseEther("1"));
  return ethers.getSigner(address);
}

describe("EpochStateCommitmentBinding", function () {
  let owner: SignerWithAddress;
  let automationRegistry: SignerWithAddress;
  let manager: SignerWithAddress;
  let strategist: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;

  let orionConfig: OrionConfig;
  let harness: LiquidityOrchestratorCommitmentHarness;
  let transparentVaultFactory: TransparentVaultFactory;
  let underlying: MockUnderlyingAsset;
  let mockVerifier: MockSP1Verifier;
  let priceAdapter: MockPriceAdapter;
  let executionAdapter: MockExecutionAdapter;

  async function createVault(name: string, symbol: string): Promise<OrionTransparentVault> {
    const tx = await transparentVaultFactory
      .connect(manager)
      .createVault(strategist.address, name, symbol, 0, 0, 0, ethers.ZeroAddress);
    const receipt = await tx.wait();
    const log = receipt?.logs.find((l) => {
      try {
        return transparentVaultFactory.interface.parseLog(l)?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const vaultAddress = transparentVaultFactory.interface.parseLog(log!)?.args?.[0] as string;
    return ethers.getContractAt("OrionTransparentVault", vaultAddress) as unknown as Promise<OrionTransparentVault>;
  }

  async function fundAndDeposit(vault: OrionTransparentVault, user: SignerWithAddress, amount: bigint) {
    await underlying.mint(user.address, amount);
    await underlying.connect(user).approve(await vault.getAddress(), amount);
    await vault.connect(user).requestDeposit(amount);
    const loSigner = await impersonate(await harness.getAddress());
    await vault.connect(loSigner).fulfillDeposit(amount);
  }

  async function startAndSealCommitment(): Promise<string> {
    const epochDuration = await harness.epochDuration();
    await networkHelpers.time.increase(Number(epochDuration) + 1);
    await harness.connect(automationRegistry).performUpkeep("0x", "0x", "0x");
    expect(await harness.currentPhase()).to.equal(PHASE_STATE_COMMITMENT);
    await expect(harness.connect(automationRegistry).performUpkeep("0x", "0x", "0x")).to.emit(
      harness,
      "EpochStateCommitted",
    );
    expect(await harness.currentPhase()).to.equal(PHASE_SELLING);
    const epoch = await harness.getEpochState();
    return epoch.epochStateCommitment;
  }

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    this.timeout(120_000);
    [owner, automationRegistry, manager, strategist, user1, user2] = await ethers.getSigners();

    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    underlying = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset;
    await underlying.waitForDeployment();

    orionConfig = await deployUUPSProxy<OrionConfig>(
      "OrionConfig",
      [owner.address, await underlying.getAddress()],
      owner,
    );

    const priceAdapterRegistry = await deployUUPSProxy<PriceAdapterRegistry>(
      "PriceAdapterRegistry",
      [owner.address, await orionConfig.getAddress()],
      owner,
    );
    await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

    const MockVerifierFactory = await ethers.getContractFactory("MockSP1Verifier");
    mockVerifier = (await MockVerifierFactory.deploy()) as unknown as MockSP1Verifier;
    await mockVerifier.waitForDeployment();

    const vKey = "0x007ccff4696ddd1d62fec2a106aa50309ba0fdee8fc2bcbc9c0b5ea68fe200f3";
    harness = await deployUUPSProxy<LiquidityOrchestratorCommitmentHarness>(
      "LiquidityOrchestratorCommitmentHarness",
      [
        owner.address,
        await orionConfig.getAddress(),
        automationRegistry.address,
        await mockVerifier.getAddress(),
        vKey,
      ],
      owner,
    );
    await orionConfig.setLiquidityOrchestrator(await harness.getAddress());

    const VaultImplFactory = await ethers.getContractFactory("OrionTransparentVault");
    const vaultImpl = await VaultImplFactory.deploy();
    await vaultImpl.waitForDeployment();
    const BeaconFactory = await ethers.getContractFactory("OrionUpgradeableBeacon");
    const vaultBeacon = (await BeaconFactory.deploy(
      await vaultImpl.getAddress(),
      owner.address,
    )) as unknown as UpgradeableBeacon;
    await vaultBeacon.waitForDeployment();

    transparentVaultFactory = await deployUUPSProxy<TransparentVaultFactory>(
      "TransparentVaultFactory",
      [owner.address, await orionConfig.getAddress(), await vaultBeacon.getAddress()],
      owner,
    );
    await orionConfig.setVaultFactory(await transparentVaultFactory.getAddress());
    await orionConfig.addWhitelistedManager(manager.address);

    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    priceAdapter = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
    await priceAdapter.waitForDeployment();
    const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
    executionAdapter = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
    await executionAdapter.waitForDeployment();

    await priceAdapter.setMockPrice(await underlying.getAddress(), 1e14);
    await orionConfig.addWhitelistedAsset(
      await underlying.getAddress(),
      await priceAdapter.getAddress(),
      await executionAdapter.getAddress(),
    );
  });

  describe("protocol state hash", function () {
    it("matches TypeScript golden vector after commitment seal", async function () {
      await createVault("Golden", "GLD");
      await startAndSealCommitment();

      const onChain = await harness.exposed_buildProtocolStateHash();
      const [netting, rs] = await orionConfig.activeProtocolFees();
      const assets = await orionConfig.getAllWhitelistedAssets();
      const tokenDecimals = await orionConfig.getAllTokenDecimals();
      const priceDec = await orionConfig.priceAdapterDecimals();
      const intentDec = await orionConfig.strategistIntentDecimals();

      const expected = hashProtocolState({
        activeNettingFeeCoefficient: netting,
        activeRsFeeCoefficient: rs,
        maxFulfillBatchSize: await orionConfig.maxFulfillBatchSize(),
        targetBufferRatio: await harness.targetBufferRatio(),
        priceAdapterDecimals: Number(priceDec),
        strategistIntentDecimals: Number(intentDec),
        epochDuration: await harness.epochDuration(),
        assets: [...assets],
        tokenDecimals: tokenDecimals.map((d: bigint) => Number(d)),
        riskFreeRate: await orionConfig.riskFreeRate(),
        decommissioningAssets: await orionConfig.decommissioningAssets(),
        failedEpochTokens: await harness.getFailedEpochTokens(),
        initialEpochBufferAmount: await harness.initialEpochBufferAmount(),
        bufferAmount: await harness.bufferAmount(),
        loBalanceUnderlying: await underlying.balanceOf(await harness.getAddress()),
      });

      expect(onChain).to.equal(expected);
    });

    it("changes hash when committed decimals fields are flipped (off-chain vectors)", function () {
      const base = {
        activeNettingFeeCoefficient: 100n,
        activeRsFeeCoefficient: 200n,
        maxFulfillBatchSize: 150n,
        targetBufferRatio: 500n,
        priceAdapterDecimals: 14,
        strategistIntentDecimals: 9,
        epochDuration: 86400n,
        assets: ["0x0000000000000000000000000000000000000001"],
        tokenDecimals: [6],
        riskFreeRate: 500n,
        decommissioningAssets: [] as string[],
        failedEpochTokens: [] as string[],
        initialEpochBufferAmount: 0n,
        bufferAmount: 1000n,
        loBalanceUnderlying: 5000n,
      };

      const baseline = hashProtocolState(base);

      expect(hashProtocolState({ ...base, priceAdapterDecimals: 18 })).to.not.equal(baseline);
      expect(hashProtocolState({ ...base, strategistIntentDecimals: 8 })).to.not.equal(baseline);
      expect(hashProtocolState({ ...base, tokenDecimals: [18] })).to.not.equal(baseline);
    });
  });

  describe("vault leaf pendingRedeemsHash", function () {
    it("uses keccak256(abi.encode([])) for empty redeem batch", function () {
      expect(pendingRedeemsHash([])).to.equal(
        ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256[]"], [[]])),
      );
    });

    it("changes epoch commitment for same sum, different redeem partitions", async function () {
      const depositAmount = ethers.parseUnits("100", 6);

      const vaultA = await createVault("PartA", "PA");
      await fundAndDeposit(vaultA, user1, depositAmount);
      await fundAndDeposit(vaultA, user2, depositAmount);
      const shares1 = (await vaultA.balanceOf(user1.address)) / 2n;
      const shares2 = (await vaultA.balanceOf(user2.address)) / 2n;
      await vaultA.connect(user1).approve(await vaultA.getAddress(), shares1);
      await vaultA.connect(user2).approve(await vaultA.getAddress(), shares2);
      await vaultA.connect(user1).requestRedeem(shares1);
      await vaultA.connect(user2).requestRedeem(shares2);
      const [, batchA] = await vaultA.pendingRedeemBatch(await orionConfig.maxFulfillBatchSize());
      const redeemSum = batchA[0] + batchA[1];
      const commitmentA = await startAndSealCommitment();

      await resetNetwork();
      [owner, automationRegistry, manager, strategist, user1, user2] = await ethers.getSigners();
      const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
      underlying = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset;
      await underlying.waitForDeployment();
      orionConfig = await deployUUPSProxy<OrionConfig>(
        "OrionConfig",
        [owner.address, await underlying.getAddress()],
        owner,
      );
      const priceAdapterRegistry = await deployUUPSProxy<PriceAdapterRegistry>(
        "PriceAdapterRegistry",
        [owner.address, await orionConfig.getAddress()],
        owner,
      );
      await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());
      mockVerifier = (await (
        await ethers.getContractFactory("MockSP1Verifier")
      ).deploy()) as unknown as MockSP1Verifier;
      await mockVerifier.waitForDeployment();
      const vKey = "0x007ccff4696ddd1d62fec2a106aa50309ba0fdee8fc2bcbc9c0b5ea68fe200f3";
      harness = await deployUUPSProxy<LiquidityOrchestratorCommitmentHarness>(
        "LiquidityOrchestratorCommitmentHarness",
        [
          owner.address,
          await orionConfig.getAddress(),
          automationRegistry.address,
          await mockVerifier.getAddress(),
          vKey,
        ],
        owner,
      );
      await orionConfig.setLiquidityOrchestrator(await harness.getAddress());
      const vaultImpl = await (await ethers.getContractFactory("OrionTransparentVault")).deploy();
      await vaultImpl.waitForDeployment();
      const vaultBeacon = (await (
        await ethers.getContractFactory("OrionUpgradeableBeacon")
      ).deploy(await vaultImpl.getAddress(), owner.address)) as unknown as UpgradeableBeacon;
      transparentVaultFactory = await deployUUPSProxy<TransparentVaultFactory>(
        "TransparentVaultFactory",
        [owner.address, await orionConfig.getAddress(), await vaultBeacon.getAddress()],
        owner,
      );
      await orionConfig.setVaultFactory(await transparentVaultFactory.getAddress());
      await orionConfig.addWhitelistedManager(manager.address);
      priceAdapter = (await (
        await ethers.getContractFactory("MockPriceAdapter")
      ).deploy()) as unknown as MockPriceAdapter;
      executionAdapter = (await (
        await ethers.getContractFactory("MockExecutionAdapter")
      ).deploy()) as unknown as MockExecutionAdapter;
      await priceAdapter.setMockPrice(await underlying.getAddress(), 1e14);
      await orionConfig.addWhitelistedAsset(
        await underlying.getAddress(),
        await priceAdapter.getAddress(),
        await executionAdapter.getAddress(),
      );

      const vaultB = await createVault("PartB", "PB");
      let deposit = depositAmount * 2n;
      await fundAndDeposit(vaultB, user1, deposit);
      while ((await vaultB.balanceOf(user1.address)) < redeemSum) {
        deposit += depositAmount;
        await fundAndDeposit(vaultB, user1, depositAmount);
      }
      await vaultB.connect(user1).approve(await vaultB.getAddress(), redeemSum);
      await vaultB.connect(user1).requestRedeem(redeemSum);
      const [, batchB] = await vaultB.pendingRedeemBatch(await orionConfig.maxFulfillBatchSize());
      const commitmentB = await startAndSealCommitment();

      expect(batchB[0]).to.equal(redeemSum);
      expect(pendingRedeemsHash([...batchA])).to.not.equal(pendingRedeemsHash([...batchB]));
      expect(commitmentA).to.not.equal(commitmentB);
    });
  });

  describe("loBalanceUnderlying donation desync", function () {
    it("stored commitment unchanged while live protocol hash diverges after donation", async function () {
      await createVault("Donation", "DON");
      const commitment = await startAndSealCommitment();
      const hashAtSeal = await harness.exposed_buildProtocolStateHash();

      const donor = user2;
      const donation = ethers.parseUnits("1000", 6);
      await underlying.mint(donor.address, donation);
      await underlying.connect(donor).transfer(await harness.getAddress(), donation);

      const epoch = await harness.getEpochState();
      expect(epoch.epochStateCommitment).to.equal(commitment);

      const hashAfterDonation = await harness.exposed_buildProtocolStateHash();
      expect(hashAfterDonation).to.not.equal(hashAtSeal);
    });
  });
});
