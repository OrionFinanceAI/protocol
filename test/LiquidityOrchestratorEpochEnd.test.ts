/**
 * LiquidityOrchestrator epoch-end gating after ProcessVaultOperations.
 *
 * Epoch-end must run only when PVO transitions to Idle — not when uint8
 * currentMinibatchIndex wraps to 0 mid-PVO.
 */
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "./helpers/hh";

import type {
  LiquidityOrchestratorHarness,
  MockERC4626Asset,
  MockUnderlyingAsset,
  MockExecutionAdapter,
  OrionConfig,
  OrionTransparentVault,
  PriceAdapterRegistry,
  TransparentVaultFactory,
  UpgradeableBeacon,
} from "../typechain-types";
import { deployUUPSProxy } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";

/** ProcessVaultOperations = 4, Idle = 0 */
const PHASE_IDLE = 0n;
const PHASE_PVO = 4n;

describe("LiquidityOrchestrator epoch-end gating", function () {
  let orionConfig: OrionConfig;
  let harness: LiquidityOrchestratorHarness;
  let transparentVaultFactory: TransparentVaultFactory;
  let underlyingAsset: MockUnderlyingAsset;

  let owner: SignerWithAddress;
  let manager: SignerWithAddress;
  let strategist: SignerWithAddress;

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
    const vaultAddress = transparentVaultFactory.interface.parseLog(log!)?.args?.[0];
    return ethers.getContractAt("OrionTransparentVault", vaultAddress) as unknown as Promise<OrionTransparentVault>;
  }

  function emptyVaultState() {
    return {
      processRedeem: false,
      totalAssetsForRedeem: 0n,
      totalAssetsForDeposit: 0n,
      finalTotalAssets: 0n,
      managementFee: 0n,
      performanceFee: 0n,
      tokens: [] as string[],
      shares: [] as bigint[],
    };
  }

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    [owner, manager, strategist] = await ethers.getSigners();

    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    underlyingAsset = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset;
    await underlyingAsset.waitForDeployment();

    orionConfig = await deployUUPSProxy<OrionConfig>(
      "OrionConfig",
      [owner.address, await underlyingAsset.getAddress()],
      owner,
    );

    const priceAdapterRegistry = await deployUUPSProxy<PriceAdapterRegistry>(
      "PriceAdapterRegistry",
      [owner.address, await orionConfig.getAddress()],
      owner,
    );
    await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

    const SP1VerifierGatewayFactory = await ethers.getContractFactory("SP1VerifierGateway");
    const sp1VerifierGateway = await SP1VerifierGatewayFactory.deploy(owner.address);
    await sp1VerifierGateway.waitForDeployment();
    const SP1VerifierFactory = await ethers.getContractFactory("SP1Verifier");
    const sp1Verifier = await SP1VerifierFactory.deploy();
    await sp1Verifier.waitForDeployment();
    await sp1VerifierGateway.addRoute(await sp1Verifier.getAddress());

    const vKey = "0x007ccff4696ddd1d62fec2a106aa50309ba0fdee8fc2bcbc9c0b5ea68fe200f3";
    harness = await deployUUPSProxy<LiquidityOrchestratorHarness>(
      "LiquidityOrchestratorHarness",
      [owner.address, await orionConfig.getAddress(), owner.address, await sp1VerifierGateway.getAddress(), vKey],
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
    const priceAdapter = await MockPriceAdapterFactory.deploy();
    await priceAdapter.waitForDeployment();

    const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
    const executionAdapter = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
    await executionAdapter.waitForDeployment();

    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    const mockVaultAsset = (await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Mock",
      "M",
    )) as unknown as MockERC4626Asset;
    await mockVaultAsset.waitForDeployment();

    await orionConfig.addWhitelistedAsset(
      await mockVaultAsset.getAddress(),
      await priceAdapter.getAddress(),
      await executionAdapter.getAddress(),
    );
  });

  it("normal PVO completion transitions to Idle and emits EpochEnd once", async function () {
    const vault = await createVault("V1", "V1");
    const vaultAddr = await vault.getAddress();

    await harness.h_setMinibatchSize(1);
    await harness.h_setVaultsEpoch([vaultAddr]);
    await harness.h_setCurrentMinibatchIndex(0);
    await harness.h_setPhase(PHASE_PVO);

    const epochBefore = await harness.epochCounter();
    const states = [emptyVaultState()];

    await expect(harness.h_processPvoMinibatchWithEpochEnd(states, 0n))
      .to.emit(harness, "EpochEnd")
      .withArgs(epochBefore, 0n);

    expect(await harness.currentPhase()).to.equal(PHASE_IDLE);
    expect(await harness.currentMinibatchIndex()).to.equal(0n);
    expect(await harness.epochCounter()).to.equal(epochBefore + 1n);
  });

  it("intermediate PVO step stays in ProcessVaultOperations without EpochEnd", async function () {
    const vault1 = await createVault("V1", "V1");
    const vault2 = await createVault("V2", "V2");

    await harness.h_setMinibatchSize(1);
    await harness.h_setVaultsEpoch([await vault1.getAddress(), await vault2.getAddress()]);
    await harness.h_setCurrentMinibatchIndex(0);
    await harness.h_setPhase(PHASE_PVO);

    const epochBefore = await harness.epochCounter();
    // vaults[] aligned with vaultsEpoch indices; only index 0 is processed this step
    const states = [emptyVaultState(), emptyVaultState()];

    await expect(harness.h_processPvoMinibatchWithEpochEnd(states, 0n)).to.not.emit(harness, "EpochEnd");

    expect(await harness.currentPhase()).to.equal(PHASE_PVO);
    expect(await harness.currentMinibatchIndex()).to.equal(1n);
    expect(await harness.epochCounter()).to.equal(epochBefore);
  });

  it("uint8 currentMinibatchIndex wrap does not trigger EpochEnd while still in PVO", async function () {
    // Full 257-vault PVO exceeds the Hardhat gas cap; this mirrors the exact completion predicate
    // from `_processMinibatchVaultsOperations` (i0/i1 vs length, uint8 ++wrap) then the Idle gate.
    await harness.h_setMinibatchSize(1);
    await harness.h_setCurrentMinibatchIndex(255);
    await harness.h_setPhase(PHASE_PVO);

    const epochBefore = await harness.epochCounter();

    await expect(harness.h_advancePvoIndexLikeProcessMinibatch(257, 0n)).to.not.emit(harness, "EpochEnd");

    // Index wraps 255 → 0; phase must remain PVO (old gate would have fired EpochEnd here)
    expect(await harness.currentPhase()).to.equal(PHASE_PVO);
    expect(await harness.currentMinibatchIndex()).to.equal(0n);
    expect(await harness.epochCounter()).to.equal(epochBefore);
  });
});
