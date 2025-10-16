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
  let transparentVault: OrionTransparentVault;

  let owner: SignerWithAddress;
  let curator: SignerWithAddress;
  let automationRegistry: SignerWithAddress;
  let user: SignerWithAddress;

  beforeEach(async function () {
    [owner, curator, automationRegistry, user] = await ethers.getSigners();

    // Deploy Mock Underlying Asset
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAssetDeployed = await MockUnderlyingAssetFactory.deploy(12);
    await underlyingAssetDeployed.waitForDeployment();
    underlyingAsset = underlyingAssetDeployed as unknown as MockUnderlyingAsset;

    // Deploy Mock ERC4626 Assets
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

    // Initialize mock assets with different amounts of underlying assets
    // This creates initial liquidity in each vault for realistic price testing
    const initialDeposit1 = ethers.parseUnits("1000", 12); // 1000 underlying assets for mockAsset1
    const initialDeposit2 = ethers.parseUnits("2000", 12); // 2000 underlying assets for mockAsset2
    const initialDeposit3 = ethers.parseUnits("1500", 12); // 1500 underlying assets for mockAsset3

    // Mint underlying assets to user for deposits
    await underlyingAsset.mint(user.address, ethers.parseUnits("10000", 12));

    // Deposit to mockAsset1
    await underlyingAsset.connect(user).approve(await mockAsset1.getAddress(), initialDeposit1);
    await mockAsset1.connect(user).deposit(initialDeposit1, user.address);

    // Deposit to mockAsset2
    await underlyingAsset.connect(user).approve(await mockAsset2.getAddress(), initialDeposit2);
    await mockAsset2.connect(user).deposit(initialDeposit2, user.address);

    // Deposit to mockAsset3
    await underlyingAsset.connect(user).approve(await mockAsset3.getAddress(), initialDeposit3);
    await mockAsset3.connect(user).deposit(initialDeposit3, user.address);

    // Deploy OrionConfig
    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    const orionConfigDeployed = await OrionConfigFactory.deploy(owner.address, await underlyingAsset.getAddress());
    await orionConfigDeployed.waitForDeployment();
    orionConfig = orionConfigDeployed as unknown as OrionConfig;

    // Deploy Price Adapter Registry
    const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
    const priceAdapterRegistryDeployed = await PriceAdapterRegistryFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
    );
    await priceAdapterRegistryDeployed.waitForDeployment();
    priceAdapterRegistry = priceAdapterRegistryDeployed as unknown as PriceAdapterRegistry;

    // Deploy OrionAssetERC4626PriceAdapter instances
    const OrionAssetERC4626PriceAdapterFactory = await ethers.getContractFactory("OrionAssetERC4626PriceAdapter");
    orionPriceAdapter = (await OrionAssetERC4626PriceAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as OrionAssetERC4626PriceAdapter;
    await orionPriceAdapter.waitForDeployment();

    // Deploy TransparentVaultFactory
    const TransparentVaultFactoryFactory = await ethers.getContractFactory("TransparentVaultFactory");
    const transparentVaultFactoryDeployed = await TransparentVaultFactoryFactory.deploy(await orionConfig.getAddress());
    await transparentVaultFactoryDeployed.waitForDeployment();
    transparentVaultFactory = transparentVaultFactoryDeployed as unknown as TransparentVaultFactory;

    // Deploy LiquidityOrchestrator first
    const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
    const liquidityOrchestratorDeployed = await LiquidityOrchestratorFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
      automationRegistry.address,
    );
    await liquidityOrchestratorDeployed.waitForDeployment();
    liquidityOrchestrator = liquidityOrchestratorDeployed as unknown as LiquidityOrchestrator;

    // Set liquidity orchestrator and price adapter registry in config before deploying InternalStatesOrchestrator
    await orionConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());
    await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

    // Deploy InternalStatesOrchestrator
    const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
    const internalStatesOrchestratorDeployed = await InternalStatesOrchestratorFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
      automationRegistry.address,
    );
    await internalStatesOrchestratorDeployed.waitForDeployment();
    internalStatesOrchestrator = internalStatesOrchestratorDeployed as unknown as InternalStatesOrchestrator;

    // Configure OrionConfig
    await orionConfig.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());
    await orionConfig.setVaultFactory(await transparentVaultFactory.getAddress());

    await internalStatesOrchestrator.connect(owner).updateProtocolFees(10, 1000);

    // Configure LiquidityOrchestrator
    await liquidityOrchestrator.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());

    // Set target buffer ratio to initialize targetBufferRatio
    await liquidityOrchestrator.setTargetBufferRatio(100); // 1% target buffer ratio

    // Test target buffer ratio validation
    await expect(liquidityOrchestrator.setTargetBufferRatio(0)).to.be.revertedWithCustomError(
      liquidityOrchestrator,
      "InvalidArguments",
    );

    await expect(liquidityOrchestrator.setTargetBufferRatio(501)).to.be.revertedWithCustomError(
      liquidityOrchestrator,
      "InvalidArguments",
    );

    // Test valid target buffer ratios
    await liquidityOrchestrator.setTargetBufferRatio(1); // 0.01% target buffer ratio
    await liquidityOrchestrator.setTargetBufferRatio(400); // 4% target buffer ratio

    // Deploy Execution Adapters
    const OrionAssetERC4626ExecutionAdapterFactory = await ethers.getContractFactory(
      "OrionAssetERC4626ExecutionAdapter",
    );
    orionExecutionAdapter = (await OrionAssetERC4626ExecutionAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as OrionAssetERC4626ExecutionAdapter;
    await orionExecutionAdapter.waitForDeployment();

    // Add assets to whitelist - creating a mixed investment universe
    // Asset 1: Mock asset with MockPriceAdapter
    await orionConfig.addWhitelistedAsset(
      await mockAsset1.getAddress(),
      await orionPriceAdapter.getAddress(),
      await orionExecutionAdapter.getAddress(),
    );
    // Asset 2: Mock asset with OrionAssetERC4626PriceAdapter
    await orionConfig.addWhitelistedAsset(
      await mockAsset2.getAddress(),
      await orionPriceAdapter.getAddress(),
      await orionExecutionAdapter.getAddress(),
    );
    // Asset 3: Mock asset with OrionAssetERC4626PriceAdapter
    await orionConfig.addWhitelistedAsset(
      await mockAsset3.getAddress(),
      await orionPriceAdapter.getAddress(),
      await orionExecutionAdapter.getAddress(),
    );

    // Create a transparent vault
    const tx = await transparentVaultFactory
      .connect(owner)
      .createVault(curator.address, "Test Transparent Vault", "TTV", 0, 0, 0);
    const receipt = await tx.wait();

    // Find the vault creation event
    const event = receipt?.logs.find((log) => {
      try {
        const parsed = transparentVaultFactory.interface.parseLog(log);
        return parsed?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });

    void expect(event).to.not.be.undefined;
    const parsedEvent = transparentVaultFactory.interface.parseLog(event!);
    const vaultAddress = parsedEvent?.args[0];

    void expect(vaultAddress).to.not.equal(ethers.ZeroAddress);

    // Get the vault contract
    transparentVault = (await ethers.getContractAt(
      "OrionTransparentVault",
      vaultAddress,
    )) as unknown as OrionTransparentVault;

    await transparentVault.connect(owner).updateFeeModel(4, 1000, 100); // HURDLE_HWM, 10% performance fee, 1% management fee

    // Submit a plaintext intent to the vault with mixed price adapters
    const intent = [
      {
        token: await mockAsset1.getAddress(),
        value: 400000000, // 40% (40% of 1e9)
      },
      {
        token: await mockAsset2.getAddress(),
        value: 350000000, // 35% (35% of 1e9)
      },
      {
        token: await mockAsset3.getAddress(),
        value: 240000000, // 24% (24% of 1e9)
      },
      { token: await underlyingAsset.getAddress(), value: 10000000 }, // 1% (1% of 1e9)
    ];
    await transparentVault.connect(curator).submitIntent(intent);

    // Make a deposit request (underlying assets already minted earlier)
    await underlyingAsset.connect(user).approve(await transparentVault.getAddress(), ethers.parseUnits("10000", 12));
    const depositAmount = ethers.parseUnits("100", 12);
    await transparentVault.connect(user).requestDeposit(depositAmount);
  });

  describe("Idle-only functionality", function () {
    it("should revert when system is not idle", async function () {
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Idle

      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      const [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // Not idle anymore

      const vaultAddress = await transparentVault.getAddress();
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

      await expect(orionConfig.removeOrionVault(await transparentVault.getAddress(), 0)).to.be.revertedWithCustomError(
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
      await expect(transparentVault.connect(user).requestDeposit(depositAmount)).to.be.revertedWithCustomError(
        transparentVault,
        "SystemNotIdle",
      );

      await expect(transparentVault.connect(user).cancelDepositRequest(depositAmount)).to.be.revertedWithCustomError(
        transparentVault,
        "SystemNotIdle",
      );

      const redeemAmount = ethers.parseUnits("50", 18);
      await expect(transparentVault.connect(user).requestRedeem(redeemAmount)).to.be.revertedWithCustomError(
        transparentVault,
        "SystemNotIdle",
      );

      await expect(transparentVault.connect(user).cancelRedeemRequest(redeemAmount)).to.be.revertedWithCustomError(
        transparentVault,
        "SystemNotIdle",
      );

      await expect(transparentVault.connect(owner).updateFeeModel(0, 1000, 200)).to.be.revertedWithCustomError(
        transparentVault,
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

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // Buffering

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
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

      expect(await liquidityOrchestrator.currentPhase()).to.equal(2);

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      expect(await liquidityOrchestrator.currentPhase()).to.equal(3);

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      expect(await liquidityOrchestrator.currentPhase()).to.equal(0);

      // Have curators request fees redemption
      const pendingFees = await transparentVault.pendingCuratorFees();
      if (pendingFees > 0) {
        await transparentVault.connect(owner).claimCuratorFees(pendingFees);
      }

      // Have LPs request redemption (test also cancel it)
      const redeemAmount = await transparentVault.balanceOf(user.address);
      expect(redeemAmount).to.be.gt(0);
      await transparentVault.connect(user).approve(await transparentVault.getAddress(), redeemAmount);
      await transparentVault.connect(user).requestRedeem(redeemAmount);
      await transparentVault.connect(user).cancelRedeemRequest(redeemAmount);
      await transparentVault.connect(user).approve(await transparentVault.getAddress(), redeemAmount);
      await transparentVault.connect(user).requestRedeem(redeemAmount);

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

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // Buffering

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
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

      expect(await liquidityOrchestrator.currentPhase()).to.equal(1);

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      expect(await liquidityOrchestrator.currentPhase()).to.equal(2);

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      expect(await liquidityOrchestrator.currentPhase()).to.equal(3);

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
      const pendingTransparentCuratorFees = await transparentVault.pendingCuratorFees();
      if (pendingTransparentCuratorFees > 0) {
        await transparentVault.connect(owner).claimCuratorFees(pendingTransparentCuratorFees);
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
    });
  });

  describe("Security Tests - InvalidState Protection", function () {
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

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // Buffering

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
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
});
