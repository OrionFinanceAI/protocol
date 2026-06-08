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

describe("Vault decommissioning completion", function () {
  let orionConfig: OrionConfig;
  let harness: LiquidityOrchestratorHarness;
  let transparentVaultFactory: TransparentVaultFactory;
  let underlyingAsset: MockUnderlyingAsset;
  let mockVaultAsset: MockERC4626Asset;

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

  async function processVaultEpochState(
    vault: OrionTransparentVault,
    tokens: string[],
    shares: bigint[],
    finalTotalAssets: bigint,
  ): Promise<void> {
    await harness.exposed_processSingleVaultOperations(
      await vault.getAddress(),
      0n,
      0n,
      finalTotalAssets,
      0n,
      0n,
      tokens,
      shares,
    );
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

    const MockERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");
    mockVaultAsset = (await MockERC4626Factory.deploy(
      await underlyingAsset.getAddress(),
      "Mock Vault Asset",
      "MVA",
    )) as unknown as MockERC4626Asset;
    await mockVaultAsset.waitForDeployment();

    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    const priceAdapter = await MockPriceAdapterFactory.deploy();
    await priceAdapter.waitForDeployment();
    const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
    const executionAdapter = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
    await executionAdapter.waitForDeployment();

    await orionConfig.addWhitelistedAsset(
      await mockVaultAsset.getAddress(),
      await priceAdapter.getAddress(),
      await executionAdapter.getAddress(),
    );
  });

  it("completes decommissioning for zero-state vault with empty portfolio", async function () {
    const vault = await createVault("Zero State", "ZS");
    const vaultAddress = await vault.getAddress();

    expect(await vault.totalAssets()).to.equal(0);
    expect((await vault.getPortfolio()).tokens).to.deep.equal([]);

    await orionConfig.connect(manager).removeOrionVault(vaultAddress);
    void expect(await orionConfig.isDecommissioningVault(vaultAddress)).to.be.true;

    await processVaultEpochState(vault, [], [], 0n);

    void expect(await orionConfig.isDecommissioningVault(vaultAddress)).to.be.false;
    void expect(await orionConfig.isDecommissionedVault(vaultAddress)).to.be.true;
    void expect(await orionConfig.isOrionVault(vaultAddress)).to.be.false;
  });

  it("completes decommissioning when portfolio is 100% underlying", async function () {
    const vault = await createVault("Underlying Only", "UO");
    const vaultAddress = await vault.getAddress();

    await orionConfig.connect(manager).removeOrionVault(vaultAddress);

    const underlying = await underlyingAsset.getAddress();
    await processVaultEpochState(vault, [underlying], [0n], 0n);

    void expect(await orionConfig.isDecommissionedVault(vaultAddress)).to.be.true;
    void expect(await orionConfig.isOrionVault(vaultAddress)).to.be.false;
  });

  it("does not complete decommissioning with open non-underlying positions", async function () {
    const vault = await createVault("Open Position", "OP");
    const vaultAddress = await vault.getAddress();

    await orionConfig.connect(manager).removeOrionVault(vaultAddress);

    const mockAssetAddress = await mockVaultAsset.getAddress();
    await processVaultEpochState(vault, [mockAssetAddress], [1000n], 1000n);

    void expect(await orionConfig.isDecommissioningVault(vaultAddress)).to.be.true;
    void expect(await orionConfig.isDecommissionedVault(vaultAddress)).to.be.false;
    void expect(await orionConfig.isOrionVault(vaultAddress)).to.be.true;
  });

  it("does not complete decommissioning with empty portfolio but non-zero finalTotalAssets", async function () {
    const vault = await createVault("Inconsistent TVL", "IT");
    const vaultAddress = await vault.getAddress();

    await orionConfig.connect(manager).removeOrionVault(vaultAddress);

    await processVaultEpochState(vault, [], [], 1000n);

    void expect(await orionConfig.isDecommissioningVault(vaultAddress)).to.be.true;
    void expect(await orionConfig.isDecommissionedVault(vaultAddress)).to.be.false;
    void expect(await orionConfig.isOrionVault(vaultAddress)).to.be.true;
  });
});
