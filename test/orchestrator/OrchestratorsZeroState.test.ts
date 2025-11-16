import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import {
  OrionConfig,
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  OrionTransparentVault,
  MockUnderlyingAsset,
} from "../../typechain-types";

describe("Orchestrators - zero deposits and zero intents", function () {
  let orionConfig: OrionConfig;
  let internalStatesOrchestrator: InternalStatesOrchestrator;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let transparentVaultFactory: TransparentVaultFactory;
  let transparentVault: OrionTransparentVault;
  let underlyingAsset: MockUnderlyingAsset;

  let owner: SignerWithAddress;
  let curator: SignerWithAddress;
  let automationRegistry: SignerWithAddress;
  let user: SignerWithAddress;

  beforeEach(async function () {
    [owner, curator, automationRegistry, user] = await ethers.getSigners();

    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAssetDeployed = await MockUnderlyingAssetFactory.deploy(12);
    await underlyingAssetDeployed.waitForDeployment();
    underlyingAsset = underlyingAssetDeployed as unknown as MockUnderlyingAsset;

    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    const orionConfigDeployed = await OrionConfigFactory.deploy(
      owner.address,
      user.address, // admin
      await underlyingAsset.getAddress(),
    );
    await orionConfigDeployed.waitForDeployment();
    orionConfig = orionConfigDeployed as unknown as OrionConfig;

    const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
    const liquidityOrchestratorDeployed = await LiquidityOrchestratorFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
      automationRegistry.address,
    );
    await liquidityOrchestratorDeployed.waitForDeployment();
    liquidityOrchestrator = liquidityOrchestratorDeployed as unknown as LiquidityOrchestrator;

    await orionConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());

    const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
    const internalStatesOrchestratorDeployed = await InternalStatesOrchestratorFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
      automationRegistry.address,
    );
    await internalStatesOrchestratorDeployed.waitForDeployment();
    internalStatesOrchestrator = internalStatesOrchestratorDeployed as unknown as InternalStatesOrchestrator;

    await orionConfig.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());

    const TransparentVaultFactoryFactory = await ethers.getContractFactory("TransparentVaultFactory");
    const transparentVaultFactoryDeployed = await TransparentVaultFactoryFactory.deploy(await orionConfig.getAddress());
    await transparentVaultFactoryDeployed.waitForDeployment();
    transparentVaultFactory = transparentVaultFactoryDeployed as unknown as TransparentVaultFactory;

    await orionConfig.setVaultFactory(await transparentVaultFactory.getAddress());

    await liquidityOrchestrator.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());
    await liquidityOrchestrator.setTargetBufferRatio(100); // 1%

    // Create transparent vault (no intent submitted)
    const tx = await transparentVaultFactory
      .connect(owner)
      .createVault(curator.address, "ZeroState TV", "ZTV", 0, 0, 0);
    const rcpt = await tx.wait();
    const ev = rcpt?.logs.find((log) => {
      try {
        const parsed = transparentVaultFactory.interface.parseLog(log);
        return parsed?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const parsedEvent = transparentVaultFactory.interface.parseLog(ev!);
    const tvAddress = parsedEvent?.args[0];
    transparentVault = (await ethers.getContractAt(
      "OrionTransparentVault",
      tvAddress,
    )) as unknown as OrionTransparentVault;

    // Mint underlying assets to user for potential deposits
    await underlyingAsset.mint(user.address, ethers.parseUnits("10000", 12));

    // Ensure no deposits or intents present
    expect(await transparentVault.pendingDeposit()).to.equal(0);
    expect(await transparentVault.pendingRedeem()).to.equal(0);
  });

  it("completes upkeep with zero TVL and zero intents without errors", async function () {
    // Fast forward time to trigger upkeep
    const epochDuration = await internalStatesOrchestrator.epochDuration();
    await time.increase(epochDuration + 1n);

    // Start
    const [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
    await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await internalStatesOrchestrator.currentPhase()).to.equal(0);
  });

  it("should not move forward when vault has no total assets and no pending deposits but has valid intent", async function () {
    // Submit a valid intent to the vault
    const intent = [
      {
        token: await underlyingAsset.getAddress(),
        weight: 1000000000, // 100% (100% of 1e9)
      },
    ];
    await transparentVault.connect(curator).submitIntent(intent);

    // Verify the vault has no total assets and no pending deposits
    expect(await transparentVault.totalAssets()).to.equal(0);
    expect(await transparentVault.pendingDeposit()).to.equal(0);

    // Verify the vault has a valid intent
    const [intentTokens, _intentWeights] = await transparentVault.getIntent();
    expect(intentTokens.length).to.be.gt(0);

    // Fast forward time to trigger upkeep
    const epochDuration = await internalStatesOrchestrator.epochDuration();
    await time.increase(epochDuration + 1n);

    // Check that upkeep is needed
    const [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
    void expect(upkeepNeeded).to.be.true;

    // Perform upkeep - should complete but not move to next phase
    await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);

    // Should remain in Idle phase (0) because no vaults were processed
    expect(await internalStatesOrchestrator.currentPhase()).to.equal(0);
  });

  it("should not move forward when vault has pending deposits but no intent submitted", async function () {
    // Make a deposit request to create pending deposits
    const depositAmount = ethers.parseUnits("100", 12);
    await underlyingAsset.connect(user).approve(await transparentVault.getAddress(), depositAmount);
    await transparentVault.connect(user).requestDeposit(depositAmount);

    // Verify the vault has pending deposits but no total assets
    expect(await transparentVault.pendingDeposit()).to.equal(depositAmount);
    expect(await transparentVault.totalAssets()).to.equal(0);

    // Verify the vault has no intent (empty intent)
    const [intentTokens, _intentWeights] = await transparentVault.getIntent();
    expect(intentTokens.length).to.equal(0);

    // Fast forward time to trigger upkeep
    const epochDuration = await internalStatesOrchestrator.epochDuration();
    await time.increase(epochDuration + 1n);

    // Check that upkeep is needed
    const [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
    void expect(upkeepNeeded).to.be.true;

    // Perform upkeep - should complete but not move to next phase
    await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);

    // Should remain in Idle phase (0) because no vaults were processed
    expect(await internalStatesOrchestrator.currentPhase()).to.equal(0);
  });
});
