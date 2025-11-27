import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
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
} from "../../typechain-types";

describe("Epoch Simulation", function () {
  const VAULT_DEPOSIT = 1000; // in underlying asset units
  const NUM_ASSETS = 100;
  const NUM_EPOCHS = 100;

  // Gaussian distribution parameters for gains/losses (very small to avoid slippage)
  const GAIN_MEAN = 0.0005;
  const GAIN_STD_DEV = 0.005;

  let transparentVaultFactory: TransparentVaultFactory;
  let orionConfig: OrionConfig;
  let underlyingAsset: MockUnderlyingAsset;
  let mockAssets: MockERC4626Asset[];
  let orionPriceAdapter: OrionAssetERC4626PriceAdapter;
  let orionExecutionAdapter: OrionAssetERC4626ExecutionAdapter;
  let priceAdapterRegistry: PriceAdapterRegistry;
  let internalStatesOrchestrator: InternalStatesOrchestrator;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let absoluteVault: OrionTransparentVault;

  let underlyingDecimals: number;

  let owner: SignerWithAddress;
  let curator: SignerWithAddress;
  let automationRegistry: SignerWithAddress;
  let user: SignerWithAddress;

  // Box-Muller transform for generating Gaussian random numbers
  function generateGaussian(mean: number, stdDev: number): number {
    const u1 = Math.random();
    const u2 = Math.random();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return z0 * stdDev + mean;
  }

  beforeEach(async function () {
    [owner, curator, automationRegistry, user] = await ethers.getSigners();

    underlyingDecimals = 12;

    // Deploy underlying asset
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAssetDeployed = await MockUnderlyingAssetFactory.deploy(underlyingDecimals);
    await underlyingAssetDeployed.waitForDeployment();
    underlyingAsset = underlyingAssetDeployed as unknown as MockUnderlyingAsset;

    // Mint a large amount of underlying assets for the user
    await underlyingAsset.mint(user.address, ethers.parseUnits("1000000", underlyingDecimals));

    // Deploy 100 mock assets
    mockAssets = [];
    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");

    for (let i = 0; i < NUM_ASSETS; i++) {
      const mockAssetDeployed = await MockERC4626AssetFactory.deploy(
        await underlyingAsset.getAddress(),
        `Mock Asset ${i + 1}`,
        `MA${i + 1}`,
      );
      await mockAssetDeployed.waitForDeployment();
      mockAssets.push(mockAssetDeployed as unknown as MockERC4626Asset);

      // Deposit initial liquidity in each asset
      const initialDeposit = ethers.parseUnits("1000", underlyingDecimals);
      const mockAsset = mockAssetDeployed as unknown as MockERC4626Asset;
      await underlyingAsset.connect(user).approve(await mockAsset.getAddress(), initialDeposit);
      await mockAsset.connect(user).deposit(initialDeposit, user.address);
    }

    // Deploy OrionConfig
    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    const orionConfigDeployed = await OrionConfigFactory.deploy(
      owner.address,
      user.address, // admin
      await underlyingAsset.getAddress(),
    );
    await orionConfigDeployed.waitForDeployment();
    orionConfig = orionConfigDeployed as unknown as OrionConfig;

    // Deploy PriceAdapterRegistry
    const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
    const priceAdapterRegistryDeployed = await PriceAdapterRegistryFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
    );
    await priceAdapterRegistryDeployed.waitForDeployment();
    priceAdapterRegistry = priceAdapterRegistryDeployed as unknown as PriceAdapterRegistry;

    // Deploy OrionAssetERC4626PriceAdapter
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

    // Deploy LiquidityOrchestrator
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

    // Deploy InternalStatesOrchestrator
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

    await liquidityOrchestrator.connect(owner).setTargetBufferRatio(100);
    await liquidityOrchestrator.connect(owner).updateMinibatchSize(8);

    // Deploy OrionAssetERC4626ExecutionAdapter
    const OrionAssetERC4626ExecutionAdapterFactory = await ethers.getContractFactory(
      "OrionAssetERC4626ExecutionAdapter",
    );
    orionExecutionAdapter = (await OrionAssetERC4626ExecutionAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as OrionAssetERC4626ExecutionAdapter;
    await orionExecutionAdapter.waitForDeployment();

    // Register all 100 assets
    for (let i = 0; i < NUM_ASSETS; i++) {
      await orionConfig.addWhitelistedAsset(
        await mockAssets[i].getAddress(),
        await orionPriceAdapter.getAddress(),
        await orionExecutionAdapter.getAddress(),
      );
    }

    await orionConfig.setProtocolRiskFreeRate(0.0423 * 10_000);

    // Create absolute fee vault
    const absoluteVaultTx = await transparentVaultFactory
      .connect(owner)
      .createVault(curator.address, "Absolute Fee Vault", "AFV", 0, 500, 50, ethers.ZeroAddress);
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

    // Set intent with all 100 assets (equal weights)
    const curatorIntentDecimals = Number(await orionConfig.curatorIntentDecimals());
    const intentFactor = 10 ** curatorIntentDecimals;
    const weightPerAsset = Math.floor(intentFactor / NUM_ASSETS);
    const intent = [];

    for (let i = 0; i < NUM_ASSETS; i++) {
      intent.push({
        token: await mockAssets[i].getAddress(),
        weight: weightPerAsset,
      });
    }

    await absoluteVault.connect(curator).submitIntent(intent);

    // Make initial deposit
    await underlyingAsset
      .connect(user)
      .approve(await absoluteVault.getAddress(), ethers.parseUnits(VAULT_DEPOSIT.toString(), underlyingDecimals));
    await absoluteVault.connect(user).requestDeposit(ethers.parseUnits(VAULT_DEPOSIT.toString(), underlyingDecimals));
  });

  it("should simulate 100 epochs with Gaussian-distributed gains/losses", async function () {
    const epochDuration = await internalStatesOrchestrator.epochDuration();
    const vaultDecimals = await absoluteVault.decimals();

    console.log("\n=== Starting 100 Epoch Simulation ===");
    console.log(`Initial deposit: ${VAULT_DEPOSIT} underlying assets`);
    console.log(`Number of assets: ${NUM_ASSETS}`);
    console.log("");

    // Get initial state
    const initialSharePrice = await absoluteVault.convertToAssets(10n ** BigInt(vaultDecimals));
    const initialTotalAssets = await absoluteVault.totalAssets();
    const initialPendingCuratorFees = await absoluteVault.pendingCuratorFees();
    const initialPendingProtocolFees = await internalStatesOrchestrator.pendingProtocolFees();

    console.log(
      `Epoch 0: Share Price = ${ethers.formatUnits(initialSharePrice, underlyingDecimals)}, Total Assets = ${ethers.formatUnits(initialTotalAssets, underlyingDecimals)}, Pending Curator Fees = ${ethers.formatUnits(initialPendingCuratorFees, underlyingDecimals)}, Pending Protocol Fees = ${ethers.formatUnits(initialPendingProtocolFees, underlyingDecimals)}`,
    );

    for (let epoch = 1; epoch <= NUM_EPOCHS; epoch++) {
      // Ensure system is idle before starting new epoch
      while (!(await orionConfig.isSystemIdle())) {
        // Process any remaining phases
        let [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        if (upkeepNeeded) {
          await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
          continue;
        }

        [upkeepNeeded, performData] = await liquidityOrchestrator.checkUpkeep("0x");
        if (upkeepNeeded) {
          await liquidityOrchestrator.connect(automationRegistry).performUpkeep(performData);
          continue;
        }
      }

      // Generate gains/losses for each asset using Gaussian distribution
      for (let i = 0; i < NUM_ASSETS; i++) {
        const gainFactor = generateGaussian(GAIN_MEAN, GAIN_STD_DEV);

        // Get current total assets in the mock asset to calculate gain/loss amount
        const mockAssetTotalAssets = await mockAssets[i].totalAssets();
        const gainLossAmount = BigInt(Math.floor(Number(mockAssetTotalAssets) * Math.abs(gainFactor)));

        if (gainFactor > 0) {
          // Simulate gain
          await underlyingAsset.connect(user).approve(await mockAssets[i].getAddress(), gainLossAmount);
          await mockAssets[i].connect(user).simulateGains(gainLossAmount);
        } else {
          // Simulate loss
          await mockAssets[i].connect(user).simulateLosses(gainLossAmount, user.address);
        }
      }

      // Advance time to trigger upkeep
      await time.increase(epochDuration + 1n);
      await time.increase((await orionConfig.feeChangeCooldownDuration()) + 1n);

      // Process InternalStatesOrchestrator phases
      // Start with handleStart (if system is idle and time has passed)
      let [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      if (upkeepNeeded) {
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }

      // Process all preprocessing minibatches
      while ((await internalStatesOrchestrator.currentPhase()) === 1n) {
        [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        if (upkeepNeeded) {
          await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
        }
      }

      // Process buffering phase
      if ((await internalStatesOrchestrator.currentPhase()) === 2n) {
        [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        if (upkeepNeeded) {
          await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
        }
      }

      // Process all postprocessing minibatches
      while ((await internalStatesOrchestrator.currentPhase()) === 3n) {
        [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        if (upkeepNeeded) {
          await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
        }
      }

      // Process building orders phase
      if ((await internalStatesOrchestrator.currentPhase()) === 4n) {
        [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        if (upkeepNeeded) {
          await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
        }
      }

      // Process LiquidityOrchestrator phases
      // Selling leg
      while ((await liquidityOrchestrator.currentPhase()) === 1n) {
        [upkeepNeeded, performData] = await liquidityOrchestrator.checkUpkeep("0x");
        if (upkeepNeeded) {
          await liquidityOrchestrator.connect(automationRegistry).performUpkeep(performData);
        }
      }

      // Buying leg
      while ((await liquidityOrchestrator.currentPhase()) === 2n) {
        [upkeepNeeded, performData] = await liquidityOrchestrator.checkUpkeep("0x");
        if (upkeepNeeded) {
          await liquidityOrchestrator.connect(automationRegistry).performUpkeep(performData);
        }
      }

      // Process vault operations
      while ((await liquidityOrchestrator.currentPhase()) === 3n) {
        [upkeepNeeded, performData] = await liquidityOrchestrator.checkUpkeep("0x");
        if (upkeepNeeded) {
          await liquidityOrchestrator.connect(automationRegistry).performUpkeep(performData);
        }
      }

      // Ensure system is idle before logging
      while (!(await orionConfig.isSystemIdle())) {
        [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        if (upkeepNeeded) {
          await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
          continue;
        }

        [upkeepNeeded, performData] = await liquidityOrchestrator.checkUpkeep("0x");
        if (upkeepNeeded) {
          await liquidityOrchestrator.connect(automationRegistry).performUpkeep(performData);
          continue;
        }
      }

      // Get and log protocol state
      const sharePrice = await absoluteVault.convertToAssets(10n ** BigInt(vaultDecimals));
      const sharePriceFormatted = ethers.formatUnits(sharePrice, underlyingDecimals);
      const totalAssets = await absoluteVault.totalAssets();
      const totalAssetsFormatted = ethers.formatUnits(totalAssets, underlyingDecimals);
      const pendingCuratorFees = await absoluteVault.pendingCuratorFees();
      const pendingCuratorFeesFormatted = ethers.formatUnits(pendingCuratorFees, underlyingDecimals);
      const pendingProtocolFees = await internalStatesOrchestrator.pendingProtocolFees();
      const pendingProtocolFeesFormatted = ethers.formatUnits(pendingProtocolFees, underlyingDecimals);
      console.log(`Epoch ${epoch}:`);
      console.log(`  Share Price: ${sharePriceFormatted}`);
      console.log(`  Total Assets: ${totalAssetsFormatted}`);
      console.log(`  Pending Curator Fees: ${pendingCuratorFeesFormatted}`);
      console.log(`  Pending Protocol Fees: ${pendingProtocolFeesFormatted}`);
    }

    console.log("\n=== Simulation Complete ===");
  });
});
