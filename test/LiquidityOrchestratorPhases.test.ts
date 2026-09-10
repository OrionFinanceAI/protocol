import { expect } from "chai";
import { networkHelpers } from "./helpers/hh";
import { ethers } from "./helpers/hh";
import { deployUUPSProxy } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";
import { encodePerformPayload, emptyVaultState } from "./helpers/loPerformPayload";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  LiquidityOrchestratorHarness,
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

const PHASE_IDLE = 0;
const PHASE_STATE_COMMITMENT = 1;
const PHASE_SELLING = 2;
const PHASE_PVO = 4;

/**
 * LO config ACL + performUpkeep phase branches that were missing from the unit suite:
 * commitment minibatch sizing, verifier/vKey ownership, StateCommitment sealing,
 * and PVO→Idle epoch-end via the automation registry (mock SP1 verifier).
 *
 * Does not re-test Buy→PVO buffer settlement (BufferAccrual) or PVO uint8 wrap gating (EpochEnd).
 */
describe("LiquidityOrchestrator – config ACL and performUpkeep phases", function () {
  let owner: SignerWithAddress;
  let guardian: SignerWithAddress;
  let automationRegistry: SignerWithAddress;
  let stranger: SignerWithAddress;
  let manager: SignerWithAddress;
  let strategist: SignerWithAddress;

  let orionConfig: OrionConfig;
  let harness: LiquidityOrchestratorHarness;
  let transparentVaultFactory: TransparentVaultFactory;
  let underlying: MockUnderlyingAsset;
  let mockVerifier: MockSP1Verifier;
  let priceAdapter: MockPriceAdapter;
  let executionAdapter: MockExecutionAdapter;

  async function whitelistExtraAsset(name: string): Promise<string> {
    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    const extra = await MockERC4626AssetFactory.deploy(await underlying.getAddress(), name, name);
    await extra.waitForDeployment();
    await orionConfig.addWhitelistedAsset(
      await extra.getAddress(),
      await priceAdapter.getAddress(),
      await executionAdapter.getAddress(),
    );
    return extra.getAddress();
  }

  async function createVault(name: string, symbol: string): Promise<OrionTransparentVault> {
    const tx = await transparentVaultFactory
      .connect(manager)
      .createVault(
        strategist.address,
        name,
        symbol,
        0,
        0,
        0,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
      );
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

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    [owner, guardian, automationRegistry, stranger, manager, strategist] = await ethers.getSigners();

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
      [await orionConfig.getAddress()],
      owner,
    );
    await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

    const MockVerifierFactory = await ethers.getContractFactory("MockSP1Verifier");
    mockVerifier = (await MockVerifierFactory.deploy()) as unknown as MockSP1Verifier;
    await mockVerifier.waitForDeployment();

    const vKey = "0x007ccff4696ddd1d62fec2a106aa50309ba0fdee8fc2bcbc9c0b5ea68fe200f3";
    harness = await deployUUPSProxy<LiquidityOrchestratorHarness>(
      "LiquidityOrchestratorHarness",
      [await orionConfig.getAddress(), automationRegistry.address, await mockVerifier.getAddress(), vKey],
      owner,
    );
    await orionConfig.setLiquidityOrchestrator(await harness.getAddress());
    await orionConfig.connect(owner).setGuardian(guardian.address);

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
      [await orionConfig.getAddress(), await vaultBeacon.getAddress()],
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

    // Whitelist underlying so epoch seal has a priced asset leaf
    await priceAdapter.setMockPrice(await underlying.getAddress(), 1e14);
    await orionConfig.addWhitelistedAsset(
      await underlying.getAddress(),
      await priceAdapter.getAddress(),
      await executionAdapter.getAddress(),
    );
  });

  describe("1. updateCommitmentMinibatchSize", function () {
    it("rejects zero and non-owner", async function () {
      await expect(harness.connect(owner).updateCommitmentMinibatchSize(0)).to.be.revertedWithCustomError(
        harness,
        "InvalidArguments",
      );
      await expect(harness.connect(stranger).updateCommitmentMinibatchSize(2)).to.be.revertedWithCustomError(
        harness,
        "NotAuthorized",
      );
      await expect(harness.connect(guardian).updateCommitmentMinibatchSize(2)).to.be.revertedWithCustomError(
        harness,
        "NotAuthorized",
      );
    });

    it("requires Idle; owner can update when Idle", async function () {
      expect(await harness.commitmentMinibatchSize()).to.equal(1n);

      await harness.h_setPhase(PHASE_PVO);
      await expect(harness.connect(owner).updateCommitmentMinibatchSize(2)).to.be.revertedWithCustomError(
        harness,
        "SystemNotIdle",
      );

      await harness.h_setPhase(PHASE_IDLE);
      await harness.connect(owner).updateCommitmentMinibatchSize(3);
      expect(await harness.commitmentMinibatchSize()).to.equal(3n);

      await harness.connect(owner).updateCommitmentMinibatchSize(4);
      expect(await harness.commitmentMinibatchSize()).to.equal(4n);
    });
  });

  describe("2. updateVerifier / updateVKey (owner-only)", function () {
    it("updateVerifier: owner succeeds, zero and non-owner revert", async function () {
      const MockVerifierFactory = await ethers.getContractFactory("MockSP1Verifier");
      const next = await MockVerifierFactory.deploy();
      await next.waitForDeployment();

      await expect(harness.connect(owner).updateVerifier(await next.getAddress()))
        .to.emit(harness, "SP1VerifierUpdated")
        .withArgs(await next.getAddress());
      expect(await harness.verifier()).to.equal(await next.getAddress());

      await expect(harness.connect(owner).updateVerifier(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        harness,
        "ZeroAddress",
      );
      await expect(harness.connect(guardian).updateVerifier(await next.getAddress())).to.be.revertedWithCustomError(
        harness,
        "NotAuthorized",
      );
      await expect(harness.connect(stranger).updateVerifier(await next.getAddress())).to.be.revertedWithCustomError(
        harness,
        "NotAuthorized",
      );
    });

    it("updateVKey: owner succeeds, zero and non-owner revert", async function () {
      const newKey = ethers.id("orion.vkey.next");
      await expect(harness.connect(owner).updateVKey(newKey)).to.emit(harness, "VKeyUpdated").withArgs(newKey);
      expect(await harness.vKey()).to.equal(newKey);

      await expect(harness.connect(owner).updateVKey(ethers.ZeroHash)).to.be.revertedWithCustomError(
        harness,
        "InvalidArguments",
      );
      await expect(harness.connect(guardian).updateVKey(newKey)).to.be.revertedWithCustomError(
        harness,
        "NotAuthorized",
      );
    });
  });

  describe("3. performUpkeep StateCommitment → _processCommitmentMinibatch", function () {
    it("seals a single-vault commitment minibatch and advances to SellingLeg", async function () {
      await createVault("Commit V1", "CV1");

      const epochDuration = await harness.epochDuration();
      await networkHelpers.time.increase(Number(epochDuration) + 1);

      // Idle → StateCommitment (_handleStart)
      await harness.connect(automationRegistry).performUpkeep("0x", "0x", "0x");
      expect(await harness.currentPhase()).to.equal(PHASE_STATE_COMMITMENT);

      // StateCommitment → fold vault leaf, seal, SellingLeg
      await expect(harness.connect(automationRegistry).performUpkeep("0x", "0x", "0x")).to.emit(
        harness,
        "EpochStateCommitted",
      );
      expect(await harness.currentPhase()).to.equal(PHASE_SELLING);
      expect(await harness.h_commitmentBatchIndex()).to.equal(1n);
      const epoch = await harness.getEpochState();
      expect(epoch.epochStateCommitment).to.not.equal(ethers.ZeroHash);
    });

    it("processes multi-vault commitment across minibatch calls", async function () {
      await createVault("V1", "V1");
      await createVault("V2", "V2");
      await harness.h_setPhase(PHASE_IDLE);
      await harness.connect(owner).updateCommitmentMinibatchSize(1);

      const epochDuration = await harness.epochDuration();
      await networkHelpers.time.increase(Number(epochDuration) + 1);

      await harness.connect(automationRegistry).performUpkeep("0x", "0x", "0x");
      expect(await harness.currentPhase()).to.equal(PHASE_STATE_COMMITMENT);

      await harness.connect(automationRegistry).performUpkeep("0x", "0x", "0x");
      expect(await harness.currentPhase()).to.equal(PHASE_STATE_COMMITMENT);
      expect(await harness.h_commitmentBatchIndex()).to.equal(1n);

      await expect(harness.connect(automationRegistry).performUpkeep("0x", "0x", "0x")).to.emit(
        harness,
        "EpochStateCommitted",
      );
      expect(await harness.currentPhase()).to.equal(PHASE_SELLING);
      expect(await harness.h_commitmentBatchIndex()).to.equal(2n);
    });
  });

  describe("4. performUpkeep PVO → Idle epoch-end", function () {
    it("emits EpochEnd, finalizes asset removal via completeAssetsRemoval, increments epochCounter", async function () {
      const vault = await createVault("PVO V1", "PV1");
      const vaultAddr = await vault.getAddress();
      const commitment = ethers.id("orion.pvo.epoch.commitment");
      const removable = await whitelistExtraAsset("Removable");

      // Decommission while Idle. Empty failedTokens → completeAssetsRemoval finalizes removal.
      await orionConfig.connect(owner).removeWhitelistedAsset(removable);
      expect(await orionConfig.decommissioningAssets()).to.deep.equal([removable]);

      await harness.h_setMinibatchSize(1);
      await harness.h_setVaultsEpoch([vaultAddr]);
      await harness.h_setCurrentMinibatchIndex(0);
      await harness.h_setPhase(PHASE_PVO);
      await harness.h_setEpochStateCommitment(commitment);

      const epochBefore = await harness.epochCounter();
      const payload = encodePerformPayload({
        inputCommitment: commitment,
        vaults: [emptyVaultState()],
        nettedRebalanceVolumeUnderlying: 42n,
      });

      await expect(
        harness
          .connect(automationRegistry)
          .performUpkeep(payload.publicValues, payload.proofBytes, payload.statesBytes),
      )
        .to.emit(harness, "EpochEnd")
        .withArgs(epochBefore, 42n);

      expect(await harness.currentPhase()).to.equal(PHASE_IDLE);
      expect(await harness.epochCounter()).to.equal(epochBefore + 1n);
      expect(await orionConfig.isWhitelisted(removable)).to.equal(false);
      expect(await orionConfig.decommissioningAssets()).to.deep.equal([]);
    });

    it("intermediate PVO minibatch stays in PVO without EpochEnd", async function () {
      const v1 = await createVault("A", "A");
      const v2 = await createVault("B", "B");
      const commitment = ethers.id("orion.pvo.partial");

      await harness.h_setMinibatchSize(1);
      await harness.h_setVaultsEpoch([await v1.getAddress(), await v2.getAddress()]);
      await harness.h_setCurrentMinibatchIndex(0);
      await harness.h_setPhase(PHASE_PVO);
      await harness.h_setEpochStateCommitment(commitment);

      const epochBefore = await harness.epochCounter();
      const payload = encodePerformPayload({
        inputCommitment: commitment,
        // Length must match vaultsEpoch; only index 0 is consumed this minibatch
        vaults: [emptyVaultState(), emptyVaultState()],
      });

      await expect(
        harness
          .connect(automationRegistry)
          .performUpkeep(payload.publicValues, payload.proofBytes, payload.statesBytes),
      ).to.not.emit(harness, "EpochEnd");

      expect(await harness.currentPhase()).to.equal(PHASE_PVO);
      expect(await harness.epochCounter()).to.equal(epochBefore);
    });
  });
});
