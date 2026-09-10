import { expect } from "chai";
import { networkHelpers } from "./helpers/hh";
import { ethers } from "./helpers/hh";
import { deployUUPSProxy } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";
import { encodePerformPayload, emptyVaultState } from "./helpers/loPerformPayload";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  EncryptedVaultFactory,
  LiquidityOrchestratorVaultHarness,
  MockExecutionAdapter,
  MockPriceAdapter,
  MockSP1Verifier,
  MockUnderlyingAsset,
  OrionConfig,
  OrionEncryptedVault,
  OrionTransparentVault,
  PriceAdapterRegistry,
  TransparentVaultFactory,
  UpgradeableBeacon,
} from "../typechain-types";

const PHASE_IDLE = 0;
const PHASE_STATE_COMMITMENT = 1;
const PHASE_SELLING = 2;
const PHASE_PVO = 4;

/** Minimal valid OrionCiphertext length (enc 32 + tag 16). */
function ciphertextOfLength(len: number): string {
  return ethers.hexlify(ethers.randomBytes(len));
}

/**
 * LO epoch membership, commitment hashing, PVO writeback, and decommission for encrypted vaults.
 *
 * Guest conventions (documented for zk-orchestrator; not executed here):
 * - empty intent ciphertext => 100% underlying
 * - empty portfolio ciphertext => liquidated for decommission completion
 */
describe("LiquidityOrchestrator – encrypted vaults", function () {
  let owner: SignerWithAddress;
  let automationRegistry: SignerWithAddress;
  let manager: SignerWithAddress;
  let strategist: SignerWithAddress;

  let orionConfig: OrionConfig;
  let harness: LiquidityOrchestratorVaultHarness;
  let transparentVaultFactory: TransparentVaultFactory;
  let encryptedVaultFactory: EncryptedVaultFactory;
  let underlying: MockUnderlyingAsset;
  let mockVerifier: MockSP1Verifier;
  let priceAdapter: MockPriceAdapter;
  let executionAdapter: MockExecutionAdapter;

  async function createTransparentVault(name: string, symbol: string): Promise<OrionTransparentVault> {
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

  async function createEncryptedVault(name: string, symbol: string): Promise<OrionEncryptedVault> {
    const tx = await encryptedVaultFactory
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
        return encryptedVaultFactory.interface.parseLog(l)?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const vaultAddress = encryptedVaultFactory.interface.parseLog(log!)?.args?.[0] as string;
    return ethers.getContractAt("OrionEncryptedVault", vaultAddress) as unknown as Promise<OrionEncryptedVault>;
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
    this.timeout(90_000);
    [owner, automationRegistry, manager, strategist] = await ethers.getSigners();

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
    harness = await deployUUPSProxy<LiquidityOrchestratorVaultHarness>(
      "LiquidityOrchestratorVaultHarness",
      [await orionConfig.getAddress(), automationRegistry.address, await mockVerifier.getAddress(), vKey],
      owner,
    );
    await orionConfig.setLiquidityOrchestrator(await harness.getAddress());

    const TransparentImplFactory = await ethers.getContractFactory("OrionTransparentVault");
    const transparentImpl = await TransparentImplFactory.deploy();
    await transparentImpl.waitForDeployment();
    const BeaconFactory = await ethers.getContractFactory("OrionUpgradeableBeacon");
    const transparentBeacon = (await BeaconFactory.deploy(
      await transparentImpl.getAddress(),
      owner.address,
    )) as unknown as UpgradeableBeacon;
    await transparentBeacon.waitForDeployment();

    transparentVaultFactory = await deployUUPSProxy<TransparentVaultFactory>(
      "TransparentVaultFactory",
      [await orionConfig.getAddress(), await transparentBeacon.getAddress()],
      owner,
    );
    await orionConfig.setVaultFactory(await transparentVaultFactory.getAddress());

    const EncryptedImplFactory = await ethers.getContractFactory("OrionEncryptedVault");
    const encryptedImpl = await EncryptedImplFactory.deploy();
    await encryptedImpl.waitForDeployment();
    const encryptedBeacon = (await BeaconFactory.deploy(
      await encryptedImpl.getAddress(),
      owner.address,
    )) as unknown as UpgradeableBeacon;
    await encryptedBeacon.waitForDeployment();

    encryptedVaultFactory = await deployUUPSProxy<EncryptedVaultFactory>(
      "EncryptedVaultFactory",
      [await orionConfig.getAddress(), await encryptedBeacon.getAddress()],
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

    // Extra asset so encrypted maxCiphertextLength > MIN (universe size > 1)
    const MockERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");
    const extra = await MockERC4626Factory.deploy(await underlying.getAddress(), "Extra", "EX");
    await extra.waitForDeployment();
    await priceAdapter.setMockPrice(await extra.getAddress(), 1e14);
    await orionConfig.addWhitelistedAsset(
      await extra.getAddress(),
      await priceAdapter.getAddress(),
      await executionAdapter.getAddress(),
    );
  });

  it("builds vaultsEpoch as transparent then encrypted", async function () {
    const t1 = await createTransparentVault("T1", "T1");
    const e1 = await createEncryptedVault("E1", "E1");
    const t2 = await createTransparentVault("T2", "T2");
    const e2 = await createEncryptedVault("E2", "E2");

    expect(await orionConfig.isEncryptedVault(await e1.getAddress())).to.equal(true);
    expect(await orionConfig.isEncryptedVault(await t1.getAddress())).to.equal(false);

    const epochDuration = await harness.epochDuration();
    await networkHelpers.time.increase(Number(epochDuration) + 1);
    await harness.connect(automationRegistry).performUpkeep("0x", "0x", "0x");

    const epoch = await harness.getEpochState();
    expect(epoch.vaultsEpoch).to.deep.equal([
      await t1.getAddress(),
      await t2.getAddress(),
      await e1.getAddress(),
      await e2.getAddress(),
    ]);
  });

  it("seals StateCommitment for an encrypted-only epoch", async function () {
    await createEncryptedVault("E-only", "EO");
    const commitment = await startAndSealCommitment();
    expect(commitment).to.not.equal(ethers.ZeroHash);
  });

  it("changes epoch commitment when encrypted portfolio/intent ciphertexts change", async function () {
    const vault = await createEncryptedVault("Hash", "HSH");
    const vaultAddr = await vault.getAddress();

    const c1 = await startAndSealCommitment();

    // Reset to Idle and change sealed blobs (intent via strategist; portfolio via LO)
    await harness.h_setPhase(PHASE_IDLE);
    const intentBlob = ciphertextOfLength(48);
    await vault.connect(strategist).submitIntent(intentBlob);

    const loAddr = await harness.getAddress();
    await networkHelpers.impersonateAccount(loAddr);
    await networkHelpers.setBalance(loAddr, ethers.parseEther("1"));
    const loSigner = await ethers.getSigner(loAddr);
    const portfolioBlob = ciphertextOfLength(64);
    await vault.connect(loSigner).updateVaultState(portfolioBlob, 0n);

    const c2 = await startAndSealCommitment();
    expect(c2).to.not.equal(c1);

    // Sanity: hashes are keccak256(raw blob), not abi.encode(blob)
    expect(ethers.keccak256(intentBlob)).to.equal(ethers.keccak256(await vault.getIntent()));
    expect(ethers.keccak256(portfolioBlob)).to.equal(ethers.keccak256(await vault.getPortfolio()));
    expect(await orionConfig.isOrionVault(vaultAddr)).to.equal(true);
  });

  it("PVO writeback stores portfolio ciphertext; transparent payload keeps empty ciphertext", async function () {
    const transparent = await createTransparentVault("T-wb", "TWB");
    const encrypted = await createEncryptedVault("E-wb", "EWB");
    const commitment = ethers.id("orion.encrypted.pvo.writeback");
    const nextPortfolio = ciphertextOfLength(80);

    await harness.h_setMinibatchSize(2);
    await harness.h_setVaultsEpoch([await transparent.getAddress(), await encrypted.getAddress()]);
    await harness.h_setCurrentMinibatchIndex(0);
    await harness.h_setPhase(PHASE_PVO);
    await harness.h_setEpochStateCommitment(commitment);

    const underlyingAddr = await underlying.getAddress();
    const payload = encodePerformPayload({
      inputCommitment: commitment,
      vaults: [
        {
          ...emptyVaultState(),
          tokens: [underlyingAddr],
          shares: [0n],
          finalTotalAssets: 0n,
          portfolioCiphertext: "0x",
        },
        {
          ...emptyVaultState(),
          tokens: [],
          shares: [],
          finalTotalAssets: 1_000_000n,
          portfolioCiphertext: nextPortfolio,
        },
      ],
    });

    await harness
      .connect(automationRegistry)
      .performUpkeep(payload.publicValues, payload.proofBytes, payload.statesBytes);

    expect(await encrypted.getPortfolio()).to.equal(nextPortfolio);
    expect(await encrypted.totalAssets()).to.equal(1_000_000n);

    const [tokens, shares] = await transparent.getPortfolio();
    expect(tokens).to.deep.equal([underlyingAddr]);
    expect(shares).to.deep.equal([0n]);
  });

  it("completes encrypted decommission when portfolio ciphertext is empty and queues are clear", async function () {
    const vault = await createEncryptedVault("E-dec", "EDC");
    const vaultAddr = await vault.getAddress();

    // Seed a non-empty portfolio, then decommission with empty writeback
    const loAddr = await harness.getAddress();
    await networkHelpers.impersonateAccount(loAddr);
    await networkHelpers.setBalance(loAddr, ethers.parseEther("1"));
    const loSigner = await ethers.getSigner(loAddr);
    await vault.connect(loSigner).updateVaultState(ciphertextOfLength(48), 100n);

    await orionConfig.connect(manager).removeOrionVault(vaultAddr);
    expect(await orionConfig.isDecommissioningVault(vaultAddr)).to.equal(true);

    // Non-empty ciphertext must not complete
    await harness.exposed_processSingleVaultOperations(vaultAddr, {
      ...emptyVaultState(),
      processRedeem: true,
      finalTotalAssets: 0n,
      portfolioCiphertext: ciphertextOfLength(48),
    });
    expect(await orionConfig.isDecommissioningVault(vaultAddr)).to.equal(true);
    expect(await orionConfig.isDecommissionedVault(vaultAddr)).to.equal(false);

    // Empty portfolio ciphertext + empty queues => complete
    await harness.exposed_processSingleVaultOperations(vaultAddr, {
      ...emptyVaultState(),
      processRedeem: true,
      finalTotalAssets: 0n,
      portfolioCiphertext: "0x",
    });
    expect(await orionConfig.isDecommissionedVault(vaultAddr)).to.equal(true);
    expect(await orionConfig.isOrionVault(vaultAddr)).to.equal(false);
    expect(await vault.getPortfolio()).to.equal("0x");
  });
});
