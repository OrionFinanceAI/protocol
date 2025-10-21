import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import {
  MockUnderlyingAsset,
  MockERC4626Asset,
  OrionAssetERC4626ExecutionAdapter,
  OrionConfig,
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  OrionTransparentVault,
  PriceAdapterRegistry,
  OrionAssetERC4626PriceAdapter,
} from "../typechain-types";

describe("Orchestrators", function () {
  let transparentVaultFactory: TransparentVaultFactory;
  let orionConfig: OrionConfig;
  let underlyingAsset: MockUnderlyingAsset;
  let mockAsset1: MockERC4626Asset;
  let mockAsset2: MockERC4626Asset;
  let mockAsset3: MockERC4626Asset;
  let orionPriceAdapter: OrionAssetERC4626PriceAdapter;
  let orionExecutionAdapter: OrionAssetERC4626ExecutionAdapter;
  let priceAdapterRegistry: PriceAdapterRegistry;
  let internalStatesOrchestrator: InternalStatesOrchestrator;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let absoluteVault: OrionTransparentVault;
  let highWaterMarkVault: OrionTransparentVault;
  let softHurdleVault: OrionTransparentVault;
  let hardHurdleVault: OrionTransparentVault;
  let hurdleHwmVault: OrionTransparentVault;

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

    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    const mockAsset1Deployed = await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Mock Asset 1",
      "MA1",
    );
    await mockAsset1Deployed.waitForDeployment();
    mockAsset1 = mockAsset1Deployed as unknown as MockERC4626Asset;

    const mockAsset2Deployed = await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Mock Asset 2",
      "MA2",
    );
    await mockAsset2Deployed.waitForDeployment();
    mockAsset2 = mockAsset2Deployed as unknown as MockERC4626Asset;

    const mockAsset3Deployed = await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Mock Asset 3",
      "MA3",
    );
    await mockAsset3Deployed.waitForDeployment();
    mockAsset3 = mockAsset3Deployed as unknown as MockERC4626Asset;

    const initialDeposit1 = ethers.parseUnits("1000", 12);
    const initialDeposit2 = ethers.parseUnits("2000", 12);
    const initialDeposit3 = ethers.parseUnits("1500", 12);

    await underlyingAsset.mint(user.address, ethers.parseUnits("10000", 12));

    await underlyingAsset.connect(user).approve(await mockAsset1.getAddress(), initialDeposit1);
    await mockAsset1.connect(user).deposit(initialDeposit1, user.address);

    await underlyingAsset.connect(user).approve(await mockAsset2.getAddress(), initialDeposit2);
    await mockAsset2.connect(user).deposit(initialDeposit2, user.address);

    await underlyingAsset.connect(user).approve(await mockAsset3.getAddress(), initialDeposit3);
    await mockAsset3.connect(user).deposit(initialDeposit3, user.address);

    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    const orionConfigDeployed = await OrionConfigFactory.deploy(owner.address, await underlyingAsset.getAddress());
    await orionConfigDeployed.waitForDeployment();
    orionConfig = orionConfigDeployed as unknown as OrionConfig;

    const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
    const priceAdapterRegistryDeployed = await PriceAdapterRegistryFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
    );
    await priceAdapterRegistryDeployed.waitForDeployment();
    priceAdapterRegistry = priceAdapterRegistryDeployed as unknown as PriceAdapterRegistry;

    const OrionAssetERC4626PriceAdapterFactory = await ethers.getContractFactory("OrionAssetERC4626PriceAdapter");
    orionPriceAdapter = (await OrionAssetERC4626PriceAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as OrionAssetERC4626PriceAdapter;
    await orionPriceAdapter.waitForDeployment();

    const TransparentVaultFactoryFactory = await ethers.getContractFactory("TransparentVaultFactory");
    const transparentVaultFactoryDeployed = await TransparentVaultFactoryFactory.deploy(await orionConfig.getAddress());
    await transparentVaultFactoryDeployed.waitForDeployment();
    transparentVaultFactory = transparentVaultFactoryDeployed as unknown as TransparentVaultFactory;

    const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
    const liquidityOrchestratorDeployed = await LiquidityOrchestratorFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
      automationRegistry.address,
    );
    await liquidityOrchestratorDeployed.waitForDeployment();
    liquidityOrchestrator = liquidityOrchestratorDeployed as unknown as LiquidityOrchestrator;

    await orionConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());
    await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

    const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
    const internalStatesOrchestratorDeployed = await InternalStatesOrchestratorFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
      automationRegistry.address,
    );
    await internalStatesOrchestratorDeployed.waitForDeployment();
    internalStatesOrchestrator = internalStatesOrchestratorDeployed as unknown as InternalStatesOrchestrator;

    await orionConfig.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());
    await orionConfig.setVaultFactory(await transparentVaultFactory.getAddress());

    await internalStatesOrchestrator.connect(owner).updateProtocolFees(10, 1000);

    await liquidityOrchestrator.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());

    await liquidityOrchestrator.setTargetBufferRatio(100); // 1% target buffer ratio

    await expect(liquidityOrchestrator.setTargetBufferRatio(0)).to.be.revertedWithCustomError(
      liquidityOrchestrator,
      "InvalidArguments",
    );

    await expect(liquidityOrchestrator.setTargetBufferRatio(501)).to.be.revertedWithCustomError(
      liquidityOrchestrator,
      "InvalidArguments",
    );

    await liquidityOrchestrator.setTargetBufferRatio(1);
    await liquidityOrchestrator.setTargetBufferRatio(400);

    const OrionAssetERC4626ExecutionAdapterFactory = await ethers.getContractFactory(
      "OrionAssetERC4626ExecutionAdapter",
    );
    orionExecutionAdapter = (await OrionAssetERC4626ExecutionAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as OrionAssetERC4626ExecutionAdapter;
    await orionExecutionAdapter.waitForDeployment();

    await orionConfig.addWhitelistedAsset(
      await mockAsset1.getAddress(),
      await orionPriceAdapter.getAddress(),
      await orionExecutionAdapter.getAddress(),
    );
    await orionConfig.addWhitelistedAsset(
      await mockAsset2.getAddress(),
      await orionPriceAdapter.getAddress(),
      await orionExecutionAdapter.getAddress(),
    );
    await orionConfig.addWhitelistedAsset(
      await mockAsset3.getAddress(),
      await orionPriceAdapter.getAddress(),
      await orionExecutionAdapter.getAddress(),
    );

    // Vault 1: ABSOLUTE fee model (0) - 5% performance fee, 0.5% management fee
    const absoluteVaultTx = await transparentVaultFactory
      .connect(owner)
      .createVault(curator.address, "Absolute Fee Vault", "AFV", 0, 500, 50);
    const absoluteVaultReceipt = await absoluteVaultTx.wait();
    const absoluteVaultEvent = absoluteVaultReceipt?.logs.find((log) => {
      try {
        const parsed = transparentVaultFactory.interface.parseLog(log);
        return parsed?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const absoluteVaultParsedEvent = transparentVaultFactory.interface.parseLog(absoluteVaultEvent!);
    const absoluteVaultAddress = absoluteVaultParsedEvent?.args[0];
    absoluteVault = (await ethers.getContractAt(
      "OrionTransparentVault",
      absoluteVaultAddress,
    )) as unknown as OrionTransparentVault;

    // Vault 2: HIGH_WATER_MARK fee model (3) - 8% performance fee, 1.5% management fee
    const highWaterMarkVaultTx = await transparentVaultFactory
      .connect(owner)
      .createVault(curator.address, "High Water Mark Vault", "HWMV", 3, 800, 150);
    const highWaterMarkVaultReceipt = await highWaterMarkVaultTx.wait();
    const highWaterMarkVaultEvent = highWaterMarkVaultReceipt?.logs.find((log) => {
      try {
        const parsed = transparentVaultFactory.interface.parseLog(log);
        return parsed?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const highWaterMarkVaultParsedEvent = transparentVaultFactory.interface.parseLog(highWaterMarkVaultEvent!);
    const highWaterMarkVaultAddress = highWaterMarkVaultParsedEvent?.args[0];
    highWaterMarkVault = (await ethers.getContractAt(
      "OrionTransparentVault",
      highWaterMarkVaultAddress,
    )) as unknown as OrionTransparentVault;

    // Vault 3: SOFT_HURDLE fee model (1) - 12% performance fee, 0.8% management fee
    const softHurdleVaultTx = await transparentVaultFactory
      .connect(owner)
      .createVault(curator.address, "Soft Hurdle Vault", "SHV", 1, 1200, 80);
    const softHurdleVaultReceipt = await softHurdleVaultTx.wait();
    const softHurdleVaultEvent = softHurdleVaultReceipt?.logs.find((log) => {
      try {
        const parsed = transparentVaultFactory.interface.parseLog(log);
        return parsed?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const softHurdleVaultParsedEvent = transparentVaultFactory.interface.parseLog(softHurdleVaultEvent!);
    const softHurdleVaultAddress = softHurdleVaultParsedEvent?.args[0];
    softHurdleVault = (await ethers.getContractAt(
      "OrionTransparentVault",
      softHurdleVaultAddress,
    )) as unknown as OrionTransparentVault;

    // Vault 4: HARD_HURDLE fee model (2) - 15% performance fee, 2% management fee
    const hardHurdleVaultTx = await transparentVaultFactory
      .connect(owner)
      .createVault(curator.address, "Hard Hurdle Vault", "HHV", 2, 1500, 200);
    const hardHurdleVaultReceipt = await hardHurdleVaultTx.wait();
    const hardHurdleVaultEvent = hardHurdleVaultReceipt?.logs.find((log) => {
      try {
        const parsed = transparentVaultFactory.interface.parseLog(log);
        return parsed?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const hardHurdleVaultParsedEvent = transparentVaultFactory.interface.parseLog(hardHurdleVaultEvent!);
    const hardHurdleVaultAddress = hardHurdleVaultParsedEvent?.args[0];
    hardHurdleVault = (await ethers.getContractAt(
      "OrionTransparentVault",
      hardHurdleVaultAddress,
    )) as unknown as OrionTransparentVault;

    // Vault 5: HURDLE_HWM fee model (4) - 20% performance fee, 2.5% management fee
    const hurdleHwmVaultTx = await transparentVaultFactory
      .connect(owner)
      .createVault(curator.address, "Hurdle HWM Vault", "HHWMV", 4, 2000, 250);
    const hurdleHwmVaultReceipt = await hurdleHwmVaultTx.wait();
    const hurdleHwmVaultEvent = hurdleHwmVaultReceipt?.logs.find((log) => {
      try {
        const parsed = transparentVaultFactory.interface.parseLog(log);
        return parsed?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const hurdleHwmVaultParsedEvent = transparentVaultFactory.interface.parseLog(hurdleHwmVaultEvent!);
    const hurdleHwmVaultAddress = hurdleHwmVaultParsedEvent?.args[0];
    hurdleHwmVault = (await ethers.getContractAt(
      "OrionTransparentVault",
      hurdleHwmVaultAddress,
    )) as unknown as OrionTransparentVault;

    // Absolute Vault: Conservative allocation with high underlying asset percentage
    const absoluteIntent = [
      {
        token: await mockAsset1.getAddress(),
        value: 200000000,
      },
      {
        token: await mockAsset2.getAddress(),
        value: 150000000,
      },
      {
        token: await mockAsset3.getAddress(),
        value: 100000000,
      },
      { token: await underlyingAsset.getAddress(), value: 550000000 },
    ];
    await absoluteVault.connect(curator).submitIntent(absoluteIntent);
    await underlyingAsset.connect(user).approve(await absoluteVault.getAddress(), ethers.parseUnits("10000", 12));
    await absoluteVault.connect(user).requestDeposit(ethers.parseUnits("50", 12));

    // High Water Mark Vault: Balanced allocation
    const highWaterMarkIntent = [
      {
        token: await mockAsset1.getAddress(),
        value: 300000000,
      },
      {
        token: await mockAsset2.getAddress(),
        value: 300000000,
      },
      {
        token: await mockAsset3.getAddress(),
        value: 250000000,
      },
      { token: await underlyingAsset.getAddress(), value: 150000000 },
    ];
    await highWaterMarkVault.connect(curator).submitIntent(highWaterMarkIntent);
    await underlyingAsset.connect(user).approve(await highWaterMarkVault.getAddress(), ethers.parseUnits("10000", 12));
    await highWaterMarkVault.connect(user).requestDeposit(ethers.parseUnits("75", 12));

    // Soft Hurdle Vault: Aggressive allocation with focus on mockAsset1
    const softHurdleIntent = [
      {
        token: await mockAsset1.getAddress(),
        value: 500000000,
      },
      {
        token: await mockAsset2.getAddress(),
        value: 250000000,
      },
      {
        token: await mockAsset3.getAddress(),
        value: 150000000,
      },
      { token: await underlyingAsset.getAddress(), value: 100000000 },
    ];
    await softHurdleVault.connect(curator).submitIntent(softHurdleIntent);
    await underlyingAsset.connect(user).approve(await softHurdleVault.getAddress(), ethers.parseUnits("10000", 12));
    await softHurdleVault.connect(user).requestDeposit(ethers.parseUnits("125", 12));

    // Hard Hurdle Vault: Diversified allocation with equal weight on mock assets
    const hardHurdleIntent = [
      {
        token: await mockAsset1.getAddress(),
        value: 250000000,
      },
      {
        token: await mockAsset2.getAddress(),
        value: 250000000,
      },
      {
        token: await mockAsset3.getAddress(),
        value: 250000000,
      },
      { token: await underlyingAsset.getAddress(), value: 250000000 },
    ];
    await hardHurdleVault.connect(curator).submitIntent(hardHurdleIntent);
    await underlyingAsset.connect(user).approve(await hardHurdleVault.getAddress(), ethers.parseUnits("10000", 12));
    await hardHurdleVault.connect(user).requestDeposit(ethers.parseUnits("200", 12));

    // Hurdle HWM Vault: Moderate allocation with focus on mockAsset2 and mockAsset3
    const hurdleHwmIntent = [
      {
        token: await mockAsset1.getAddress(),
        value: 150000000,
      },
      {
        token: await mockAsset2.getAddress(),
        value: 350000000,
      },
      {
        token: await mockAsset3.getAddress(),
        value: 350000000,
      },
      { token: await underlyingAsset.getAddress(), value: 150000000 },
    ];
    await hurdleHwmVault.connect(curator).submitIntent(hurdleHwmIntent);
    await underlyingAsset.connect(user).approve(await hurdleHwmVault.getAddress(), ethers.parseUnits("10000", 12));
    await hurdleHwmVault.connect(user).requestDeposit(ethers.parseUnits("150", 12));
  });

  describe("Idle-only functionality", function () {
    it("should revert when system is not idle", async function () {
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Idle

      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      const [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // Not idle anymore

      const vaultAddress = await hurdleHwmVault.getAddress();
      await expect(orionConfig.removeOrionVault(vaultAddress, 1)).to.be.revertedWithCustomError(
        orionConfig,
        "SystemNotIdle",
      );

      await expect(
        orionConfig.setVaultFactory(await transparentVaultFactory.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "SystemNotIdle");

      await expect(orionConfig.setProtocolRiskFreeRate(1000)).to.be.revertedWithCustomError(
        orionConfig,
        "SystemNotIdle",
      );

      await expect(
        orionConfig.addWhitelistedAsset(
          await mockAsset1.getAddress(),
          await orionPriceAdapter.getAddress(),
          await orionExecutionAdapter.getAddress(),
        ),
      ).to.be.revertedWithCustomError(orionConfig, "SystemNotIdle");

      await expect(orionConfig.removeWhitelistedAsset(await mockAsset1.getAddress())).to.be.revertedWithCustomError(
        orionConfig,
        "SystemNotIdle",
      );

      await expect(orionConfig.removeOrionVault(await hurdleHwmVault.getAddress(), 0)).to.be.revertedWithCustomError(
        orionConfig,
        "SystemNotIdle",
      );

      // Test InternalStatesOrchestrator functions
      await expect(internalStatesOrchestrator.updateEpochDuration(3600)).to.be.revertedWithCustomError(
        internalStatesOrchestrator,
        "SystemNotIdle",
      );

      await expect(internalStatesOrchestrator.updateMinibatchSize(5)).to.be.revertedWithCustomError(
        internalStatesOrchestrator,
        "SystemNotIdle",
      );

      await expect(internalStatesOrchestrator.updateProtocolFees(50, 1000)).to.be.revertedWithCustomError(
        internalStatesOrchestrator,
        "SystemNotIdle",
      );

      // Test LiquidityOrchestrator functions
      await expect(liquidityOrchestrator.updateExecutionMinibatchSize(10)).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "SystemNotIdle",
      );

      await expect(liquidityOrchestrator.updateAutomationRegistry(user.address)).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "SystemNotIdle",
      );

      await expect(liquidityOrchestrator.setTargetBufferRatio(100)).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "SystemNotIdle",
      );

      // Test vault functions
      const depositAmount = ethers.parseUnits("100", 12);
      await expect(hurdleHwmVault.connect(user).requestDeposit(depositAmount)).to.be.revertedWithCustomError(
        hurdleHwmVault,
        "SystemNotIdle",
      );

      await expect(hurdleHwmVault.connect(user).cancelDepositRequest(depositAmount)).to.be.revertedWithCustomError(
        hurdleHwmVault,
        "SystemNotIdle",
      );

      const redeemAmount = ethers.parseUnits("50", 18);
      await expect(hurdleHwmVault.connect(user).requestRedeem(redeemAmount)).to.be.revertedWithCustomError(
        hurdleHwmVault,
        "SystemNotIdle",
      );

      await expect(hurdleHwmVault.connect(user).cancelRedeemRequest(redeemAmount)).to.be.revertedWithCustomError(
        hurdleHwmVault,
        "SystemNotIdle",
      );

      await expect(hurdleHwmVault.connect(owner).updateFeeModel(0, 1000, 200)).to.be.revertedWithCustomError(
        hurdleHwmVault,
        "SystemNotIdle",
      );

      // Test factory function
      await expect(
        transparentVaultFactory.createVault(curator.address, "Test Transparent Vault", "TTV", 0, 0, 0),
      ).to.be.revertedWithCustomError(transparentVaultFactory, "SystemNotIdle");
    });
  });

  describe("performUpkeep", function () {
    it("should complete full upkeep cycles without intent decryption", async function () {
      // Skip intent decryption - don't await decryption oracle
      // Encrypted Vault intents is invalid, so they are not processed

      // Fast forward time to trigger upkeep
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Idle

      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      let [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      // Process all vaults in preprocessing phase - continue until we reach buffering phase
      while ((await internalStatesOrchestrator.currentPhase()) === 1n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // Buffering

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

      // Process all vaults in postprocessing phase - continue until we reach building orders phase
      while ((await internalStatesOrchestrator.currentPhase()) === 3n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Back to Idle
      expect(await internalStatesOrchestrator.epochCounter()).to.equal(1); // Epoch incremented

      // Check that orders were built
      let [sellingTokens, _sellingAmounts, buyingTokens, _buyingAmounts] = await internalStatesOrchestrator.getOrders();

      // Check that all amounts are greater than 0
      for (const amount of _sellingAmounts) {
        expect(amount).to.be.gt(0);
      }
      for (const amount of _buyingAmounts) {
        expect(amount).to.be.gt(0);
      }

      // Should have all three assets in the orders arrays
      expect(sellingTokens.length).to.equal(0);
      expect(buyingTokens.length).to.equal(4);

      // Interact with investment universe assets here, leading to mismatch between measured and execution prices.
      // Simulate different gains for each mock asset to create price mismatches
      const gainAmount1 = ethers.parseUnits("10", 12);
      await underlyingAsset.connect(user).approve(await mockAsset1.getAddress(), gainAmount1);
      await mockAsset1.connect(user).simulateGains(gainAmount1);

      const gainAmount2 = ethers.parseUnits("10", 12);
      await underlyingAsset.connect(user).approve(await mockAsset2.getAddress(), gainAmount2);
      await mockAsset2.connect(user).simulateGains(gainAmount2);

      const gainAmount3 = ethers.parseUnits("15", 12);
      await underlyingAsset.connect(user).approve(await mockAsset3.getAddress(), gainAmount3);
      await mockAsset3.connect(user).simulateGains(gainAmount3);

      // Now check if liquidity orchestrator needs to be triggered
      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle

      let [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // BuyingLeg

      while ((await liquidityOrchestrator.currentPhase()) === 2n) {
        [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
        void expect(liquidityUpkeepNeeded).to.be.true;
        await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      }

      expect(await liquidityOrchestrator.currentPhase()).to.equal(3); // FulfillDepositAndRedeem

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle

      // Have curators request fees redemption
      const pendingFees = await hurdleHwmVault.pendingCuratorFees();
      if (pendingFees > 0) {
        await hurdleHwmVault.connect(owner).claimCuratorFees(pendingFees);
      }

      // Have LPs request redemption (test also cancel it)
      const redeemAmount = await hurdleHwmVault.balanceOf(user.address);
      expect(redeemAmount).to.be.gt(0);
      await hurdleHwmVault.connect(user).approve(await hurdleHwmVault.getAddress(), redeemAmount);
      await hurdleHwmVault.connect(user).requestRedeem(redeemAmount);
      await hurdleHwmVault.connect(user).cancelRedeemRequest(redeemAmount / 2n);

      // Get the updated balance after cancellation
      const updatedRedeemAmount = await hurdleHwmVault.balanceOf(user.address);
      await hurdleHwmVault.connect(user).approve(await hurdleHwmVault.getAddress(), updatedRedeemAmount);
      await hurdleHwmVault.connect(user).requestRedeem(updatedRedeemAmount);

      // Inject a lot of capital in asset tokens to increase their share price so in the next epoch there is a non-zero performance fee
      const largeDepositAmount = ethers.parseUnits("1000000", 12); // 1M tokens
      await underlyingAsset.connect(owner).mint(owner.address, largeDepositAmount);
      await underlyingAsset.connect(owner).approve(await mockAsset1.getAddress(), largeDepositAmount);
      await mockAsset1.connect(owner).deposit(largeDepositAmount, owner.address);

      // Fast forward time to trigger upkeep
      await time.increase(epochDuration + 1n);

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");

      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      // Process all vaults in preprocessing phase - continue until we reach buffering phase
      while ((await internalStatesOrchestrator.currentPhase()) === 1n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // Buffering

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

      // Process all vaults in postprocessing phase - continue until we reach building orders phase
      while ((await internalStatesOrchestrator.currentPhase()) === 3n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Back to Idle
      expect(await internalStatesOrchestrator.epochCounter()).to.equal(2); // Epoch incremented

      // Check that orders were built
      [sellingTokens, _sellingAmounts, buyingTokens, _buyingAmounts] = await internalStatesOrchestrator.getOrders();

      // Check that all amounts are greater than 0
      for (const amount of _sellingAmounts) {
        expect(amount).to.be.gt(0);
      }

      expect(sellingTokens.length + buyingTokens.length).to.equal(4);

      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      expect(await liquidityOrchestrator.currentPhase()).to.equal(1); // SellingLeg

      while ((await liquidityOrchestrator.currentPhase()) === 1n) {
        [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
        void expect(liquidityUpkeepNeeded).to.be.true;
        await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      }

      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // BuyingLeg

      while ((await liquidityOrchestrator.currentPhase()) === 2n) {
        [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
        void expect(liquidityUpkeepNeeded).to.be.true;
        await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      }

      expect(await liquidityOrchestrator.currentPhase()).to.equal(3); // FulfillDepositAndRedeem

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      expect(await liquidityOrchestrator.currentPhase()).to.equal(0);

      // Test LiquidityOrchestrator functions
      await expect(liquidityOrchestrator.updateExecutionMinibatchSize(1)).to.not.be.reverted;

      // Check and claim protocol fees
      const pendingProtocolFees = await internalStatesOrchestrator.pendingProtocolFees();
      if (pendingProtocolFees > 0) {
        await liquidityOrchestrator.connect(owner).claimProtocolFees(pendingProtocolFees);
      }

      // Check and claim curator fees for transparent vault
      const pendingTransparentCuratorFees = await hurdleHwmVault.pendingCuratorFees();
      if (pendingTransparentCuratorFees > 0) {
        await hurdleHwmVault.connect(owner).claimCuratorFees(pendingTransparentCuratorFees);
      }

      const epochTokens = await internalStatesOrchestrator.getEpochTokens();
      expect(epochTokens.length).to.be.gt(0);

      const expectedTokens = [
        await mockAsset1.getAddress(),
        await mockAsset2.getAddress(),
        await mockAsset3.getAddress(),
        await underlyingAsset.getAddress(),
      ];

      for (const expectedToken of expectedTokens) {
        expect(epochTokens).to.include(expectedToken);
      }

      for (const token of epochTokens) {
        const price = await internalStatesOrchestrator.getPriceOf(token);
        expect(price).to.be.gt(0);

        if (token === (await underlyingAsset.getAddress())) {
          // Underlying asset price should be 1
          expect(price).to.equal(ethers.parseUnits("1", 14));
        } else {
          // Mock asset prices should be strictly positive
          expect(price).to.be.gt(0);
        }
      }
    });

    it("should not trigger upkeep when system is idle and time hasn't passed", async function () {
      // Don't fast forward time, so system should be idle because time hasn't passed
      const [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      void expect(upkeepNeeded).to.be.false;
      void expect(performData).to.equal("0x");
    });

    it("should not trigger upkeep when not enough time has passed", async function () {
      // Fast forward less than epoch duration
      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration / 2n);

      const [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");

      void expect(upkeepNeeded).to.be.false;
      void expect(performData).to.equal("0x");
    });

    it("should allow owner to call performUpkeep", async function () {
      // Fast forward time to trigger upkeep
      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      const [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");

      // Should succeed when called by owner
      await expect(internalStatesOrchestrator.connect(owner).performUpkeep(performData)).to.not.be.reverted;
    });

    it("should allow automation registry to call performUpkeep", async function () {
      // Fast forward time to trigger upkeep
      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      const [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");

      // Should succeed when called by automation registry
      await expect(internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData)).to.not.be
        .reverted;
    });

    it("should not allow unauthorized addresses to call performUpkeep", async function () {
      // Fast forward time to trigger upkeep
      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      const [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");

      // Should fail when called by non-authorized address (user)
      await expect(internalStatesOrchestrator.connect(user).performUpkeep(performData)).to.be.revertedWithCustomError(
        internalStatesOrchestrator,
        "NotAuthorized",
      );
    });

    it("should not trigger liquidity orchestrator when epoch counter hasn't changed", async function () {
      // Initially, liquidity orchestrator should not need upkeep
      let [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.false;
      expect(liquidityPerformData).to.equal("0x");

      // Now liquidity orchestrator should not need upkeep
      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.false;
      expect(liquidityPerformData).to.equal("0x");
    });

    it("should allow owner to call liquidity orchestrator performUpkeep", async function () {
      // Get valid performData for liquidity orchestrator
      const [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");

      // Should succeed when called by owner (only if upkeep is needed)
      if (liquidityUpkeepNeeded) {
        await expect(liquidityOrchestrator.connect(owner).performUpkeep(liquidityPerformData)).to.not.be.reverted;
      }
    });

    it("should allow automation registry to call liquidity orchestrator performUpkeep", async function () {
      // Get valid performData for liquidity orchestrator
      const [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");

      // Should succeed when called by automation registry (only if upkeep is needed)
      if (liquidityUpkeepNeeded) {
        await expect(liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData)).to.not.be
          .reverted;
      }
    });

    it("should not allow unauthorized addresses to call liquidity orchestrator performUpkeep", async function () {
      // Get valid performData for liquidity orchestrator
      const [_liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");

      // Should fail when called by non-authorized address (user)
      await expect(
        liquidityOrchestrator.connect(user).performUpkeep(liquidityPerformData),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "NotAuthorized");
    });

    it("should handle target buffer ratio calculations safely with edge cases", async function () {
      // Test with typical target buffer ratio
      await liquidityOrchestrator.setTargetBufferRatio(100);

      // Verify target buffer ratio is set correctly
      expect(await liquidityOrchestrator.targetBufferRatio()).to.equal(100);
    });

    it("should test internal states orchestrator with positive deltaAmount scenario", async function () {
      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      let [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1);

      // Process all vaults in preprocessing phase - continue until we reach buffering phase
      while ((await internalStatesOrchestrator.currentPhase()) === 1n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2);

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(3);

      // Process all vaults in postprocessing phase - continue until we reach building orders phase
      while ((await internalStatesOrchestrator.currentPhase()) === 3n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(4);

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0);
      expect(await internalStatesOrchestrator.epochCounter()).to.equal(1);

      const initialBufferAmount = await internalStatesOrchestrator.bufferAmount();

      // Create price mismatch by simulating losses AFTER the oracle price call but BEFORE liquidity orchestrator execution
      // This will cause the execution price to be lower than the oracle price, leading to decreasing buffer amount.

      let [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // From Idle to BuyingLeg (no selling in this scenario)

      // Simulate losses in mock assets to decrease their share prices
      const lossAmount1 = ethers.parseUnits("5", 12);
      await mockAsset1.connect(owner).simulateLosses(lossAmount1, owner.address);

      const lossAmount2 = ethers.parseUnits("7", 12);
      await mockAsset2.connect(owner).simulateLosses(lossAmount2, owner.address);

      const lossAmount3 = ethers.parseUnits("10", 12);
      await mockAsset3.connect(owner).simulateLosses(lossAmount3, owner.address);

      // Continue liquidity orchestrator execution phases
      while ((await liquidityOrchestrator.currentPhase()) === 2n) {
        [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
        void expect(liquidityUpkeepNeeded).to.be.true;
        await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      }

      expect(await liquidityOrchestrator.currentPhase()).to.equal(3); // FulfillDepositAndRedeem

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle

      // Check that buffer amount has changed due to market impact
      const finalBufferAmount = await internalStatesOrchestrator.bufferAmount();
      // The buffer amount should have changed due to market impact.
      expect(finalBufferAmount).to.be.gt(initialBufferAmount);

      // Start a new epoch to test the complete cycle with the updated buffer
      await time.increase(epochDuration + 1n);

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1);

      // Process all vaults in preprocessing phase - continue until we reach buffering phase
      while ((await internalStatesOrchestrator.currentPhase()) === 1n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2);

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(3);

      // Process all vaults in postprocessing phase - continue until we reach building orders phase
      while ((await internalStatesOrchestrator.currentPhase()) === 3n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(4);

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0);
      expect(await internalStatesOrchestrator.epochCounter()).to.equal(2);

      const depositAmount = ethers.parseUnits("1000", 12);
      const bufferAmountBeforeDeposit = await internalStatesOrchestrator.bufferAmount();

      await underlyingAsset.connect(owner).mint(owner.address, depositAmount);
      await underlyingAsset.connect(owner).approve(await liquidityOrchestrator.getAddress(), depositAmount);

      await liquidityOrchestrator.connect(owner).depositLiquidity(depositAmount);

      // Check that the buffer amount increased by the deposit amount
      const bufferAmountAfterDeposit = await internalStatesOrchestrator.bufferAmount();
      expect(bufferAmountAfterDeposit).to.equal(bufferAmountBeforeDeposit + depositAmount);

      const withdrawAmount = ethers.parseUnits("500", 12);
      const bufferAmountBeforeWithdraw = bufferAmountAfterDeposit;

      await liquidityOrchestrator.connect(owner).withdrawLiquidity(withdrawAmount);

      const bufferAmountAfterWithdraw = await internalStatesOrchestrator.bufferAmount();
      expect(bufferAmountAfterWithdraw).to.equal(bufferAmountBeforeWithdraw - withdrawAmount);
    });
  });

  describe("configuration", function () {
    it("should allow owner to update epoch duration", async function () {
      const newEpochDuration = 2 * 24 * 60 * 60; // 2 days
      await internalStatesOrchestrator.updateEpochDuration(newEpochDuration);
      expect(await internalStatesOrchestrator.epochDuration()).to.equal(newEpochDuration);
    });

    it("should allow owner to update minibatch sizes", async function () {
      await expect(internalStatesOrchestrator.updateMinibatchSize(2)).to.not.be.reverted;
    });

    it("should allow owner to update protocol fees", async function () {
      await internalStatesOrchestrator.updateProtocolFees(50, 100); // 0.5% volume fee, 1% revenue share
      expect(await internalStatesOrchestrator.vFeeCoefficient()).to.equal(50);
      expect(await internalStatesOrchestrator.rsFeeCoefficient()).to.equal(100);
    });

    it("should revert when updating protocol fees with invalid arguments", async function () {
      // Test with volume fee coefficient exceeding maximum
      await expect(internalStatesOrchestrator.updateProtocolFees(101, 100)).to.be.revertedWithCustomError(
        internalStatesOrchestrator,
        "InvalidArguments",
      );

      // Test with revenue share fee coefficient exceeding maximum
      await expect(internalStatesOrchestrator.updateProtocolFees(50, 2001)).to.be.revertedWithCustomError(
        internalStatesOrchestrator,
        "InvalidArguments",
      );

      // Test with both coefficients exceeding maximum
      await expect(internalStatesOrchestrator.updateProtocolFees(101, 2001)).to.be.revertedWithCustomError(
        internalStatesOrchestrator,
        "InvalidArguments",
      );
    });

    it("should not allow non-owner to update configuration", async function () {
      await expect(
        internalStatesOrchestrator.connect(curator).updateEpochDuration(86400),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "OwnableUnauthorizedAccount");
    });

    it("should revert when updating automation registry with zero address", async function () {
      await expect(
        internalStatesOrchestrator.updateAutomationRegistry(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "ZeroAddress");
    });

    it("should revert when updating automation registry when system is not idle", async function () {
      // Fast forward time to trigger upkeep and make system not idle
      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      const [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);

      // Now system is not idle (in PreprocessingTransparentVaults phase)
      const newAutomationRegistry = user.address;
      await expect(
        internalStatesOrchestrator.updateAutomationRegistry(newAutomationRegistry),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "SystemNotIdle");
    });

    it("should successfully update automation registry and emit event", async function () {
      const newAutomationRegistry = user.address;

      await expect(internalStatesOrchestrator.updateAutomationRegistry(newAutomationRegistry))
        .to.emit(internalStatesOrchestrator, "AutomationRegistryUpdated")
        .withArgs(newAutomationRegistry);

      expect(await internalStatesOrchestrator.automationRegistry()).to.equal(newAutomationRegistry);

      await expect(liquidityOrchestrator.updateAutomationRegistry(newAutomationRegistry))
        .to.emit(liquidityOrchestrator, "AutomationRegistryUpdated")
        .withArgs(newAutomationRegistry);

      expect(await liquidityOrchestrator.automationRegistry()).to.equal(newAutomationRegistry);
    });
  });

  describe("Security Tests - InternalStatesOrchestrator InvalidState Protection", function () {
    const createMaliciousPerformData = (action: string, minibatchIndex: number = 0) => {
      const actionHash = ethers.keccak256(ethers.toUtf8Bytes(action));
      const actionBytes4 = actionHash.slice(0, 10);
      return ethers.AbiCoder.defaultAbiCoder().encode(["bytes4", "uint8"], [actionBytes4, minibatchIndex]);
    };

    it("should revert with InvalidState when calling preprocessTV in wrong phase", async function () {
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Idle

      const maliciousData = createMaliciousPerformData("preprocessTV(uint8)", 0);

      await expect(
        internalStatesOrchestrator.connect(automationRegistry).performUpkeep(maliciousData),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "InvalidState");
    });

    it("should revert with InvalidState when calling buffer in wrong phase", async function () {
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Idle

      const maliciousData = createMaliciousPerformData("buffer()", 0);

      await expect(
        internalStatesOrchestrator.connect(automationRegistry).performUpkeep(maliciousData),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "InvalidState");
    });

    it("should revert with InvalidState when calling postprocessTV in wrong phase", async function () {
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Idle

      const maliciousData = createMaliciousPerformData("postprocessTV(uint8)", 0);

      await expect(
        internalStatesOrchestrator.connect(automationRegistry).performUpkeep(maliciousData),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "InvalidState");
    });

    it("should revert with InvalidState when calling buildOrders in wrong phase", async function () {
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Idle

      const maliciousData = createMaliciousPerformData("buildOrders()", 0);

      await expect(
        internalStatesOrchestrator.connect(automationRegistry).performUpkeep(maliciousData),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "InvalidState");
    });

    it("should revert with InvalidState when trying to execute phases out of order", async function () {
      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      const [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      const maliciousData = createMaliciousPerformData("buffer()", 0);

      await expect(
        internalStatesOrchestrator.connect(automationRegistry).performUpkeep(maliciousData),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "InvalidState");
    });

    it("should revert with InvalidState when trying to replay completed phases", async function () {
      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      let [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      // Process all vaults in preprocessing phase - continue until we reach buffering phase
      while ((await internalStatesOrchestrator.currentPhase()) === 1n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // Buffering

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

      // Process all vaults in postprocessing phase - continue until we reach building orders phase
      while ((await internalStatesOrchestrator.currentPhase()) === 3n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Back to Idle

      const maliciousData = createMaliciousPerformData("preprocessTV(uint8)", 0);

      await expect(
        internalStatesOrchestrator.connect(automationRegistry).performUpkeep(maliciousData),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "InvalidState");
    });

    it("should revert with InvalidState when trying to execute wrong minibatch action in current phase", async function () {
      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      const [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      const maliciousData = createMaliciousPerformData("buffer()", 0);

      await expect(
        internalStatesOrchestrator.connect(automationRegistry).performUpkeep(maliciousData),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "InvalidState");
    });
  });

  describe("Security Tests - LiquidityOrchestrator InvalidState Protection", function () {
    const createMaliciousLiquidityPerformData = (action: string, minibatchIndex: number = 0) => {
      const actionHash = ethers.keccak256(ethers.toUtf8Bytes(action));
      const actionBytes4 = actionHash.slice(0, 10);
      return ethers.AbiCoder.defaultAbiCoder().encode(["bytes4", "uint8"], [actionBytes4, minibatchIndex]);
    };

    it("should not update phase when calling start() in any phase", async function () {
      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle

      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      let [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      // Process all vaults in preprocessing phase - continue until we reach buffering phase
      while ((await internalStatesOrchestrator.currentPhase()) === 1n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // Buffering

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

      // Process all vaults in postprocessing phase - continue until we reach building orders phase
      while ((await internalStatesOrchestrator.currentPhase()) === 3n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Back to Idle

      const [_liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // BuyingLeg (skips SellingLeg since no selling tokens)

      const maliciousData = createMaliciousLiquidityPerformData("start()", 0);
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(maliciousData);

      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // No phase change.
    });

    it("should revert with InvalidState when calling processSell(uint8) in wrong phase", async function () {
      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle

      const maliciousData = createMaliciousLiquidityPerformData("processSell(uint8)", 0);
      await expect(
        liquidityOrchestrator.connect(automationRegistry).performUpkeep(maliciousData),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "InvalidState");
    });

    it("should revert with InvalidState when calling processBuy(uint8) in wrong phase", async function () {
      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle

      const maliciousData = createMaliciousLiquidityPerformData("processBuy(uint8)", 0);
      await expect(
        liquidityOrchestrator.connect(automationRegistry).performUpkeep(maliciousData),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "InvalidState");
    });

    it("should revert with InvalidState when calling processFulfillDepositAndRedeem() in wrong phase", async function () {
      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle

      const maliciousData = createMaliciousLiquidityPerformData("processFulfillDepositAndRedeem()", 0);
      await expect(
        liquidityOrchestrator.connect(automationRegistry).performUpkeep(maliciousData),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "InvalidState");
    });

    it("should revert with InvalidState when trying to execute phases out of order", async function () {
      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      let [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      // Process all vaults in preprocessing phase - continue until we reach buffering phase
      while ((await internalStatesOrchestrator.currentPhase()) === 1n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // Buffering

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

      // Process all vaults in postprocessing phase - continue until we reach building orders phase
      while ((await internalStatesOrchestrator.currentPhase()) === 3n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Back to Idle

      const [_liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // BuyingLeg (skips SellingLeg since no selling tokens)

      const maliciousData = createMaliciousLiquidityPerformData("processSell(uint8)", 0);
      await expect(
        liquidityOrchestrator.connect(automationRegistry).performUpkeep(maliciousData),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "InvalidState");
    });

    it("should revert with InvalidState when trying to replay completed phases", async function () {
      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      let [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      // Process all vaults in preprocessing phase - continue until we reach buffering phase
      while ((await internalStatesOrchestrator.currentPhase()) === 1n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // Buffering

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

      // Process all vaults in postprocessing phase - continue until we reach building orders phase
      while ((await internalStatesOrchestrator.currentPhase()) === 3n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Back to Idle

      let [_liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // BuyingLeg (skips SellingLeg since no selling tokens)

      while ((await liquidityOrchestrator.currentPhase()) === 2n) {
        [_liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
        await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      }

      expect(await liquidityOrchestrator.currentPhase()).to.equal(3); // FulfillDepositAndRedeem

      [_liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Back to Idle

      const maliciousData = createMaliciousLiquidityPerformData("processBuy(uint8)", 0);
      await expect(
        liquidityOrchestrator.connect(automationRegistry).performUpkeep(maliciousData),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "InvalidState");
    });

    it("should revert with InvalidState when trying to execute wrong minibatch action in current phase", async function () {
      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      let [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      // Process all vaults in preprocessing phase - continue until we reach buffering phase
      while ((await internalStatesOrchestrator.currentPhase()) === 1n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // Buffering

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

      // Process all vaults in postprocessing phase - continue until we reach building orders phase
      while ((await internalStatesOrchestrator.currentPhase()) === 3n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Back to Idle

      const [_liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // BuyingLeg (skips SellingLeg since no selling tokens)

      const maliciousData = createMaliciousLiquidityPerformData("processFulfillDepositAndRedeem()", 0);

      await expect(
        liquidityOrchestrator.connect(automationRegistry).performUpkeep(maliciousData),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "InvalidState");
    });

    it("should revert with InvalidState when trying to execute processSell in BuyingLeg phase", async function () {
      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      let [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      // Process all vaults in preprocessing phase - continue until we reach buffering phase
      while ((await internalStatesOrchestrator.currentPhase()) === 1n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // Buffering

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

      // Process all vaults in postprocessing phase - continue until we reach building orders phase
      while ((await internalStatesOrchestrator.currentPhase()) === 3n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Back to Idle

      const [_liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // BuyingLeg (skips SellingLeg since no selling tokens)

      const maliciousData = createMaliciousLiquidityPerformData("processSell(uint8)", 0);
      await expect(
        liquidityOrchestrator.connect(automationRegistry).performUpkeep(maliciousData),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "InvalidState");
    });

    it("should revert with InvalidState when trying to execute processBuy in FulfillDepositAndRedeem phase", async function () {
      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      let [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      // Process all vaults in preprocessing phase - continue until we reach buffering phase
      while ((await internalStatesOrchestrator.currentPhase()) === 1n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // Buffering

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

      // Process all vaults in postprocessing phase - continue until we reach building orders phase
      while ((await internalStatesOrchestrator.currentPhase()) === 3n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Back to Idle

      let [_liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // BuyingLeg (skips SellingLeg since no selling tokens)

      [_liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // Still BuyingLeg (processing minibatches)

      [_liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // Still BuyingLeg (processing minibatches)

      [_liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // Still BuyingLeg (processing minibatches)

      [_liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      expect(await liquidityOrchestrator.currentPhase()).to.equal(3); // FulfillDepositAndRedeem

      const maliciousData = createMaliciousLiquidityPerformData("processBuy(uint8)", 0);
      await expect(
        liquidityOrchestrator.connect(automationRegistry).performUpkeep(maliciousData),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "InvalidState");
    });
  });
});
