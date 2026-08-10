/**
 * EncryptedVaultFactory ACL/upgrade paths, OrionConfig encrypted-factory/HPKE/manager-removal
 * edges, and LiquidityOrchestrator SellingLeg / commitment minibatch / CommitmentMismatch.
 */
import { expect } from "chai";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { AbiCoder } from "ethers";
import { ethers, networkHelpers } from "./helpers/hh";
import { deployUUPSProxy } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";
import { encodePerformPayload } from "./helpers/loPerformPayload";
import type {
  EncryptedVaultFactory,
  LiquidityOrchestratorHarness,
  MockExecutionAdapter,
  MockPriceAdapter,
  MockSP1Verifier,
  MockUnderlyingAsset,
  OrionConfig,
  PriceAdapterRegistry,
  TransparentVaultFactory,
  UpgradeableBeacon,
} from "../typechain-types";

const PHASE_IDLE = 0;
const PHASE_STATE_COMMITMENT = 1;
const PHASE_SELLING = 2;
const PHASE_PVO = 4;

const PUBLIC_VALUES_TYPE = "tuple(bytes32 inputCommitment,bytes32 outputCommitment)";

describe("EncryptedVaultFactory / Config / LO edge branches", function () {
  let owner: SignerWithAddress;
  let manager: SignerWithAddress;
  let strategist: SignerWithAddress;
  let stranger: SignerWithAddress;
  let automationRegistry: SignerWithAddress;

  let orionConfig: OrionConfig;
  let harness: LiquidityOrchestratorHarness;
  let encryptedVaultFactory: EncryptedVaultFactory;
  let transparentVaultFactory: TransparentVaultFactory;
  let vaultBeacon: UpgradeableBeacon;
  let underlying: MockUnderlyingAsset;
  let mockVerifier: MockSP1Verifier;
  let priceAdapter: MockPriceAdapter;
  let executionAdapter: MockExecutionAdapter;

  async function impersonate(addr: string) {
    await networkHelpers.impersonateAccount(addr);
    await networkHelpers.setBalance(addr, ethers.parseEther("10"));
    return ethers.getSigner(addr);
  }

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    this.timeout(90_000);
    [owner, manager, strategist, stranger, automationRegistry] = await ethers.getSigners();

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
    harness = await deployUUPSProxy<LiquidityOrchestratorHarness>(
      "LiquidityOrchestratorHarness",
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

    const TransparentImpl = await ethers.getContractFactory("OrionTransparentVault");
    const transparentImpl = await TransparentImpl.deploy();
    await transparentImpl.waitForDeployment();
    const BeaconFactory = await ethers.getContractFactory("OrionUpgradeableBeacon");
    const transparentBeacon = (await BeaconFactory.deploy(
      await transparentImpl.getAddress(),
      owner.address,
    )) as unknown as UpgradeableBeacon;
    await transparentBeacon.waitForDeployment();

    transparentVaultFactory = await deployUUPSProxy<TransparentVaultFactory>(
      "TransparentVaultFactory",
      [owner.address, await orionConfig.getAddress(), await transparentBeacon.getAddress()],
      owner,
    );
    await orionConfig.setVaultFactory(await transparentVaultFactory.getAddress());

    const EncryptedImpl = await ethers.getContractFactory("OrionEncryptedVault");
    const encryptedImpl = await EncryptedImpl.deploy();
    await encryptedImpl.waitForDeployment();
    vaultBeacon = (await BeaconFactory.deploy(
      await encryptedImpl.getAddress(),
      owner.address,
    )) as unknown as UpgradeableBeacon;
    await vaultBeacon.waitForDeployment();

    encryptedVaultFactory = await deployUUPSProxy<EncryptedVaultFactory>(
      "EncryptedVaultFactory",
      [owner.address, await orionConfig.getAddress(), await vaultBeacon.getAddress()],
      owner,
    );
    await orionConfig.setEncryptedVaultFactory(await encryptedVaultFactory.getAddress());
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

  describe("EncryptedVaultFactory", function () {
    it("initialize rejects zero owner / config / beacon", async function () {
      const Impl = await ethers.getContractFactory("EncryptedVaultFactory");
      const impl = await Impl.deploy();
      await impl.waitForDeployment();
      const Proxy = await ethers.getContractFactory("OrionERC1967Proxy");

      const badOwner = Impl.interface.encodeFunctionData("initialize", [
        ethers.ZeroAddress,
        await orionConfig.getAddress(),
        await vaultBeacon.getAddress(),
      ]);
      await expect(Proxy.deploy(await impl.getAddress(), badOwner)).to.be.revertedWithCustomError(
        encryptedVaultFactory,
        "ZeroAddress",
      );

      const badConfig = Impl.interface.encodeFunctionData("initialize", [
        owner.address,
        ethers.ZeroAddress,
        await vaultBeacon.getAddress(),
      ]);
      await expect(Proxy.deploy(await impl.getAddress(), badConfig)).to.be.revertedWithCustomError(
        encryptedVaultFactory,
        "ZeroAddress",
      );

      const badBeacon = Impl.interface.encodeFunctionData("initialize", [
        owner.address,
        await orionConfig.getAddress(),
        ethers.ZeroAddress,
      ]);
      await expect(Proxy.deploy(await impl.getAddress(), badBeacon)).to.be.revertedWithCustomError(
        encryptedVaultFactory,
        "ZeroAddress",
      );
    });

    it("createVault rejects long name/symbol, non-manager, and non-idle system", async function () {
      const longName = "abcdefghijklmnopqrstuvwxyzA"; // 27
      await expect(
        encryptedVaultFactory
          .connect(manager)
          .createVault(strategist.address, longName, "EV", 0, 0, 0, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(encryptedVaultFactory, "InvalidArguments");

      await expect(
        encryptedVaultFactory
          .connect(manager)
          .createVault(strategist.address, "Ok", "LONGG", 0, 0, 0, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(encryptedVaultFactory, "InvalidArguments");

      await expect(
        encryptedVaultFactory
          .connect(stranger)
          .createVault(strategist.address, "Ok", "EV", 0, 0, 0, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(encryptedVaultFactory, "NotAuthorized");

      await harness.h_setPhase(PHASE_PVO);
      await expect(
        encryptedVaultFactory.connect(manager).createVault(strategist.address, "Ok", "EV", 0, 0, 0, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(encryptedVaultFactory, "SystemNotIdle");
      await harness.h_setPhase(PHASE_IDLE);
    });

    it("setVaultBeacon updates and rejects zero", async function () {
      const BeaconFactory = await ethers.getContractFactory("OrionUpgradeableBeacon");
      const EncryptedImpl = await ethers.getContractFactory("OrionEncryptedVault");
      const newImpl = await EncryptedImpl.deploy();
      await newImpl.waitForDeployment();
      const newBeacon = await BeaconFactory.deploy(await newImpl.getAddress(), owner.address);
      await newBeacon.waitForDeployment();

      await expect(
        encryptedVaultFactory.connect(owner).setVaultBeacon(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(encryptedVaultFactory, "ZeroAddress");

      await expect(encryptedVaultFactory.connect(owner).setVaultBeacon(await newBeacon.getAddress()))
        .to.emit(encryptedVaultFactory, "VaultBeaconUpdated")
        .withArgs(await newBeacon.getAddress());
      expect(await encryptedVaultFactory.vaultBeacon()).to.equal(await newBeacon.getAddress());
    });

    it("setUpgradeTimelock bootstrap ACL and replacement by timelock", async function () {
      await expect(
        encryptedVaultFactory.connect(stranger).setUpgradeTimelock(stranger.address),
      ).to.be.revertedWithCustomError(encryptedVaultFactory, "NotAuthorized");

      await expect(
        encryptedVaultFactory.connect(owner).setUpgradeTimelock(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(encryptedVaultFactory, "ZeroAddress");

      await encryptedVaultFactory.connect(owner).setUpgradeTimelock(stranger.address);
      expect(await encryptedVaultFactory.upgradeTimelock()).to.equal(stranger.address);

      await expect(
        encryptedVaultFactory.connect(owner).setUpgradeTimelock(owner.address),
      ).to.be.revertedWithCustomError(encryptedVaultFactory, "NotAuthorized");

      await encryptedVaultFactory.connect(stranger).setUpgradeTimelock(manager.address);
      expect(await encryptedVaultFactory.upgradeTimelock()).to.equal(manager.address);
    });

    it("covers _authorizeUpgrade owner and timelock paths", async function () {
      const Impl = await ethers.getContractFactory("EncryptedVaultFactory");
      const newImpl = await Impl.deploy();
      await newImpl.waitForDeployment();

      await expect(
        encryptedVaultFactory.connect(stranger).upgradeToAndCall(await newImpl.getAddress(), "0x"),
      ).to.be.revertedWithCustomError(encryptedVaultFactory, "NotAuthorized");

      await encryptedVaultFactory.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");

      const newerImpl = await Impl.deploy();
      await newerImpl.waitForDeployment();
      await encryptedVaultFactory.connect(owner).setUpgradeTimelock(stranger.address);

      await expect(
        encryptedVaultFactory.connect(owner).upgradeToAndCall(await newerImpl.getAddress(), "0x"),
      ).to.be.revertedWithCustomError(encryptedVaultFactory, "NotAuthorized");

      await encryptedVaultFactory.connect(stranger).upgradeToAndCall(await newerImpl.getAddress(), "0x");
    });
  });

  describe("OrionConfig encrypted factory / HPKE / manager removal", function () {
    it("setEncryptedVaultFactory rejects non-idle and zero", async function () {
      // Bare config (no encrypted factory yet); point LO at harness for phase control.
      const freshConfig = await deployUUPSProxy<OrionConfig>(
        "OrionConfig",
        [owner.address, await underlying.getAddress()],
        owner,
      );
      await freshConfig.setLiquidityOrchestrator(await harness.getAddress());

      await harness.h_setPhase(PHASE_PVO);
      await expect(freshConfig.connect(owner).setEncryptedVaultFactory(stranger.address)).to.be.revertedWithCustomError(
        freshConfig,
        "SystemNotIdle",
      );
      await harness.h_setPhase(PHASE_IDLE);

      await expect(
        freshConfig.connect(owner).setEncryptedVaultFactory(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(freshConfig, "ZeroAddress");
    });

    it("setHpkePublicKey rejects zero key", async function () {
      await expect(orionConfig.connect(owner).setHpkePublicKey(ethers.ZeroHash)).to.be.revertedWithCustomError(
        orionConfig,
        "InvalidArguments",
      );
    });

    it("removeWhitelistedManager hits InvalidAddress when manager removed via reentrancy", async function () {
      const Malicious = await ethers.getContractFactory("MaliciousManagerRemovalVault");
      const malicious = await Malicious.deploy(await orionConfig.getAddress(), manager.address);
      await malicious.waitForDeployment();

      const factorySigner = await impersonate(await encryptedVaultFactory.getAddress());
      await orionConfig.connect(factorySigner).addOrionVault(await malicious.getAddress(), 1);

      await orionConfig.connect(owner).transferOwnership(await malicious.getAddress());
      await malicious.acceptOwnership();
      expect(await orionConfig.owner()).to.equal(await malicious.getAddress());

      await expect(malicious.triggerRemoveManager()).to.be.revertedWithCustomError(orionConfig, "InvalidAddress");
      // Outer tx reverts after the nested remove, so manager whitelist is unchanged.
      expect(await orionConfig.isWhitelistedManager(manager.address)).to.equal(true);
    });

    it("completeVaultDecommissioning transparent-only path after dual registration", async function () {
      // Dual-register so the first complete removes encrypted only; second cycle hits transparent remove.
      // Neither-set InvalidAddress at complete is unreachable via the public API.
      const tx = await encryptedVaultFactory
        .connect(manager)
        .createVault(strategist.address, "Dual", "DU", 0, 0, 0, ethers.ZeroAddress);
      const receipt = await tx.wait();
      const log = receipt?.logs.find((l) => {
        try {
          return encryptedVaultFactory.interface.parseLog(l)?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      const vaultAddr = encryptedVaultFactory.interface.parseLog(log!)?.args?.[0] as string;

      const tvFactorySigner = await impersonate(await transparentVaultFactory.getAddress());
      await orionConfig.connect(tvFactorySigner).addOrionVault(vaultAddr, 0);

      await orionConfig.connect(manager).removeOrionVault(vaultAddr);
      const loSigner = await impersonate(await harness.getAddress());
      await orionConfig.connect(loSigner).completeVaultDecommissioning(vaultAddr);
      expect(await orionConfig.isEncryptedVault(vaultAddr)).to.equal(false);
      expect(await orionConfig.isOrionVault(vaultAddr)).to.equal(true);

      await orionConfig.connect(manager).removeOrionVault(vaultAddr);
      await orionConfig.connect(loSigner).completeVaultDecommissioning(vaultAddr);
      expect(await orionConfig.isOrionVault(vaultAddr)).to.equal(false);
      expect(await orionConfig.isDecommissionedVault(vaultAddr)).to.equal(true);
    });
  });

  describe("LiquidityOrchestrator SellingLeg / commitment / mismatch", function () {
    async function createEncryptedVault() {
      const tx = await encryptedVaultFactory
        .connect(manager)
        .createVault(strategist.address, "E", "E", 0, 0, 0, ethers.ZeroAddress);
      const receipt = await tx.wait();
      const log = receipt?.logs.find((l) => {
        try {
          return encryptedVaultFactory.interface.parseLog(l)?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      return encryptedVaultFactory.interface.parseLog(log!)?.args?.[0] as string;
    }

    it("clamps commitment minibatch when size exceeds remaining vaults", async function () {
      await createEncryptedVault();
      await harness.connect(owner).updateCommitmentMinibatchSize(50);

      const epochDuration = await harness.epochDuration();
      await networkHelpers.time.increase(Number(epochDuration) + 1);
      await harness.connect(automationRegistry).performUpkeep("0x", "0x", "0x");
      expect(await harness.currentPhase()).to.equal(PHASE_STATE_COMMITMENT);

      await expect(harness.connect(automationRegistry).performUpkeep("0x", "0x", "0x")).to.emit(
        harness,
        "EpochStateCommitted",
      );
      expect(await harness.currentPhase()).to.equal(PHASE_SELLING);
      expect(await harness.h_commitmentBatchIndex()).to.equal(1n);
    });

    it("performUpkeep SellingLeg with empty sell via verifyPerformData", async function () {
      await createEncryptedVault();
      const commitment = ethers.id("orion.sell.coverage");
      await harness.h_setPhase(PHASE_SELLING);
      await harness.h_setEpochStateCommitment(commitment);
      await harness.h_setExecutionMinibatchSize(1);
      await harness.h_setCurrentMinibatchIndex(0);

      const payload = encodePerformPayload({ inputCommitment: commitment });
      await harness
        .connect(automationRegistry)
        .performUpkeep(payload.publicValues, payload.proofBytes, payload.statesBytes);
      expect(await harness.currentPhase()).to.equal(3); // BuyingLeg
    });

    it("reverts CommitmentMismatch on input and output commitments", async function () {
      const commitment = ethers.id("orion.commit.match");
      await harness.h_setPhase(PHASE_SELLING);
      await harness.h_setEpochStateCommitment(commitment);

      const badInput = encodePerformPayload({ inputCommitment: ethers.id("wrong-input") });
      await expect(
        harness
          .connect(automationRegistry)
          .performUpkeep(badInput.publicValues, badInput.proofBytes, badInput.statesBytes),
      ).to.be.revertedWithCustomError(harness, "CommitmentMismatch");

      const good = encodePerformPayload({ inputCommitment: commitment });
      const publicValues = AbiCoder.defaultAbiCoder().encode(
        [PUBLIC_VALUES_TYPE],
        [{ inputCommitment: commitment, outputCommitment: ethers.id("wrong-output") }],
      );
      await expect(
        harness.connect(automationRegistry).performUpkeep(publicValues, "0x", good.statesBytes),
      ).to.be.revertedWithCustomError(harness, "CommitmentMismatch");
    });
  });
});
