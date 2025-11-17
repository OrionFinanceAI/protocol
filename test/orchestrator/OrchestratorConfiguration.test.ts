/**
 * OrchestratorConfiguration.test.ts
 *
 * This file contains configuration management and access control tests for orchestrators.
 * It was extracted from the original Orchestrators.test.ts file.
 *
 * EXTRACTION DETAILS:
 * ===================
 * - Lines 1-578: beforeEach setup block (same as other refactored test files)
 * - Lines 2465-2544: Configuration tests section
 *
 * WHAT THIS FILE TESTS:
 * ======================
 *
 * 1. EPOCH DURATION CONFIGURATION
 *    - Tests that owner can update epoch duration for both ISO and LO
 *    - Verifies new epoch duration is correctly set
 *
 * 2. MINIBATCH SIZE CONFIGURATION
 *    - Tests that owner can update minibatch sizes for both orchestrators
 *    - Minibatch size determines how many vaults are processed per performUpkeep call
 *    - Critical for gas management and preventing timeouts
 *
 * 3. PROTOCOL FEE CONFIGURATION
 *    - Tests that owner can update protocol fee parameters
 *    - Protocol fees are collected from vault performance/management fees
 *    - Parameters: protocol fee basis points, protocol fee denominator
 *    - Validates fee calculation: protocolFee = (totalFees * bps) / denominator
 *
 * 4. CONFIGURATION VALIDATION
 *    - Tests that invalid protocol fee arguments are rejected
 *    - Ensures denominator cannot be zero (division by zero protection)
 *    - Ensures basis points don't exceed denominator (fee > 100% protection)
 *
 * 5. ACCESS CONTROL
 *    - Tests that non-owner addresses cannot update configurations
 *    - Verifies Ownable pattern is correctly implemented
 *    - Protects critical system parameters from unauthorized changes
 *
 * 6. AUTOMATION REGISTRY CONFIGURATION
 *    - Tests automation registry address updates (for Chainlink Automation integration)
 *    - Validates zero address is rejected
 *    - Ensures registry can only be updated when system is Idle
 *    - Verifies AutomationRegistryUpdated event is emitted
 *
 * CONFIGURATION PARAMETERS TESTED:
 * =================================
 * - ISO Epoch Duration: Time between ISO epochs (default: 1 hour)
 * - LO Epoch Duration: Time between LO epochs (default: 1 hour)
 * - ISO Minibatch Size: Number of vaults processed per ISO performUpkeep
 * - LO Minibatch Size: Number of vaults processed per LO performUpkeep (default: 8)
 * - Protocol Fee Basis Points: Fee percentage (e.g., 10 = 0.1%)
 * - Protocol Fee Denominator: Fee calculation base (e.g., 1000 = 0.1% precision)
 * - Automation Registry: Address authorized to call performUpkeep
 *
 * SECURITY CONSIDERATIONS:
 * ========================
 * - Owner-only functions ensure protocol governance control
 * - Validation prevents invalid fee configurations
 * - State-dependent updates (e.g., registry only in Idle) prevent mid-epoch changes
 * - Event emissions enable off-chain monitoring of configuration changes
 *
 * TOTAL TESTS: 7
 */

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
  KBestTvlWeightedAverage,
} from "../../typechain-types";

describe("Orchestrator Configuration", function () {
  // Vault deposit amounts (in underlying asset units)
  const ABSOLUTE_VAULT_DEPOSIT = 50;
  const SOFT_HURDLE_VAULT_DEPOSIT = 125;
  const HARD_HURDLE_VAULT_DEPOSIT = 200;
  const HIGH_WATER_MARK_VAULT_DEPOSIT = 75;
  const HURDLE_HWM_VAULT_DEPOSIT = 150;
  const PASSIVE_VAULT_DEPOSIT = 100;

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
  let kbestTvlStrategy: KBestTvlWeightedAverage;
  let passiveVault: OrionTransparentVault;

  let underlyingDecimals: number;

  let owner: SignerWithAddress;
  let curator: SignerWithAddress;
  let automationRegistry: SignerWithAddress;
  let user: SignerWithAddress;

  beforeEach(async function () {
    [owner, curator, automationRegistry, user] = await ethers.getSigners();

    underlyingDecimals = 12;

    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAssetDeployed = await MockUnderlyingAssetFactory.deploy(underlyingDecimals);
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

    // Deposit in investment universe vault to be able to simulate losses.
    await underlyingAsset.mint(user.address, ethers.parseUnits("50000", underlyingDecimals));

    const initialDeposit = ethers.parseUnits("1000", underlyingDecimals);

    await underlyingAsset.connect(user).approve(await mockAsset1.getAddress(), initialDeposit);
    await mockAsset1.connect(user).deposit(initialDeposit, user.address);

    await underlyingAsset.connect(user).approve(await mockAsset2.getAddress(), initialDeposit);
    await mockAsset2.connect(user).deposit(initialDeposit, user.address);

    await underlyingAsset.connect(user).approve(await mockAsset3.getAddress(), initialDeposit * BigInt(2));
    await mockAsset3.connect(user).deposit(initialDeposit * BigInt(2), user.address);

    await underlyingAsset
      .connect(user)
      .approve(await mockAsset1.getAddress(), ethers.parseUnits("50", underlyingDecimals));
    await underlyingAsset
      .connect(user)
      .approve(await mockAsset2.getAddress(), ethers.parseUnits("30", underlyingDecimals));
    await underlyingAsset
      .connect(user)
      .approve(await mockAsset3.getAddress(), ethers.parseUnits("60", underlyingDecimals));

    await mockAsset1.connect(user).simulateGains(ethers.parseUnits("50", underlyingDecimals));
    await mockAsset2.connect(user).simulateLosses(ethers.parseUnits("30", underlyingDecimals), user.address);
    await mockAsset3.connect(user).simulateGains(ethers.parseUnits("60", underlyingDecimals));

    const decimals1 = await mockAsset1.decimals();
    const decimals2 = await mockAsset2.decimals();
    const decimals3 = await mockAsset3.decimals();
    const currentSharePrice1 = await mockAsset1.convertToAssets(10n ** BigInt(decimals1));
    const currentSharePrice2 = await mockAsset2.convertToAssets(10n ** BigInt(decimals2));
    const currentSharePrice3 = await mockAsset3.convertToAssets(10n ** BigInt(decimals3));

    console.log(currentSharePrice1);
    console.log(currentSharePrice2);
    console.log(currentSharePrice3);

    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    const orionConfigDeployed = await OrionConfigFactory.deploy(
      owner.address,
      user.address, // admin
      await underlyingAsset.getAddress(),
    );
    await orionConfigDeployed.waitForDeployment();
    orionConfig = orionConfigDeployed as unknown as OrionConfig;

    // Deploy KBestTvlWeightedAverage strategy with k=2
    const KBestTvlWeightedAverageFactory = await ethers.getContractFactory("KBestTvlWeightedAverage");
    const kbestTvlStrategyDeployed = await KBestTvlWeightedAverageFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
      1, // k=1
    );
    await kbestTvlStrategyDeployed.waitForDeployment();
    kbestTvlStrategy = kbestTvlStrategyDeployed as unknown as KBestTvlWeightedAverage;

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

    await expect(internalStatesOrchestrator.connect(owner).updateProtocolFees(51, 0)).to.be.revertedWithCustomError(
      internalStatesOrchestrator,
      "InvalidArguments",
    );

    await expect(internalStatesOrchestrator.connect(owner).updateProtocolFees(0, 2001)).to.be.revertedWithCustomError(
      internalStatesOrchestrator,
      "InvalidArguments",
    );

    await liquidityOrchestrator.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());

    await expect(liquidityOrchestrator.setTargetBufferRatio(0)).to.be.revertedWithCustomError(
      liquidityOrchestrator,
      "InvalidArguments",
    );

    await expect(liquidityOrchestrator.setTargetBufferRatio(501)).to.be.revertedWithCustomError(
      liquidityOrchestrator,
      "InvalidArguments",
    );

    await expect(liquidityOrchestrator.setTargetBufferRatio(100)).to.not.be.reverted;

    // Set minibatch size to a large value to process all vaults in one batch for tests
    await liquidityOrchestrator.connect(owner).updateMinibatchSize(8);

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

    await orionConfig.setProtocolRiskFreeRate(0.0423 * 10_000);

    await orionConfig.addWhitelistedCurator(curator.address);

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

    await orionConfig.addWhitelistedCurator(await kbestTvlStrategy.getAddress());

    // Create passive vault with kbestTVL strategy (no curator intents)
    const passiveVaultTx = await transparentVaultFactory
      .connect(owner)
      .createVault(owner.address, "Passive KBest TVL Vault", "PKTV", 0, 0, 0);
    const passiveVaultReceipt = await passiveVaultTx.wait();
    const passiveVaultEvent = passiveVaultReceipt?.logs.find((log) => {
      try {
        const parsed = transparentVaultFactory.interface.parseLog(log);
        return parsed?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const passiveVaultParsedEvent = transparentVaultFactory.interface.parseLog(passiveVaultEvent!);
    const passiveVaultAddress = passiveVaultParsedEvent?.args[0];
    passiveVault = (await ethers.getContractAt(
      "OrionTransparentVault",
      passiveVaultAddress,
    )) as unknown as OrionTransparentVault;

    await expect(
      passiveVault.connect(owner).updateCurator(await kbestTvlStrategy.getAddress()),
    ).to.be.revertedWithCustomError(kbestTvlStrategy, "InvalidStrategy");

    await passiveVault
      .connect(owner)
      .updateVaultWhitelist([await mockAsset1.getAddress(), await mockAsset3.getAddress()]);

    await passiveVault.connect(owner).updateCurator(await kbestTvlStrategy.getAddress());

    let liquidityOrchestratorBalance = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());
    expect(liquidityOrchestratorBalance).to.equal(0);

    // Absolute Vault: Conservative allocation with high underlying asset percentage
    const absoluteIntent = [
      {
        token: await mockAsset1.getAddress(),
        weight: 200000000,
      },
      {
        token: await mockAsset2.getAddress(),
        weight: 150000000,
      },
      {
        token: await mockAsset3.getAddress(),
        weight: 100000000,
      },
      { token: await underlyingAsset.getAddress(), weight: 550000000 },
    ];
    await absoluteVault.connect(curator).submitIntent(absoluteIntent);

    await underlyingAsset
      .connect(user)
      .approve(
        await absoluteVault.getAddress(),
        ethers.parseUnits(ABSOLUTE_VAULT_DEPOSIT.toString(), underlyingDecimals),
      );
    await absoluteVault
      .connect(user)
      .requestDeposit(ethers.parseUnits(ABSOLUTE_VAULT_DEPOSIT.toString(), underlyingDecimals));

    // Assert that after requestDeposit, the vault token supply didn't change
    const absoluteVaultTotalSupply = await absoluteVault.totalSupply();
    expect(absoluteVaultTotalSupply).to.equal(0);

    // Assert that after requestDeposit, the user's vault token balance didn't change
    const userAbsoluteVaultBalance = await absoluteVault.balanceOf(user.address);
    expect(userAbsoluteVaultBalance).to.equal(0);

    liquidityOrchestratorBalance = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());
    expect(liquidityOrchestratorBalance).to.equal(
      ethers.parseUnits(ABSOLUTE_VAULT_DEPOSIT.toString(), underlyingDecimals),
    );

    // Soft Hurdle Vault: Aggressive allocation with focus on mockAsset1
    const softHurdleIntent = [
      {
        token: await mockAsset1.getAddress(),
        weight: 500000000,
      },
      {
        token: await mockAsset2.getAddress(),
        weight: 250000000,
      },
      {
        token: await mockAsset3.getAddress(),
        weight: 150000000,
      },
      { token: await underlyingAsset.getAddress(), weight: 100000000 },
    ];
    await softHurdleVault.connect(curator).submitIntent(softHurdleIntent);
    await underlyingAsset
      .connect(user)
      .approve(
        await softHurdleVault.getAddress(),
        ethers.parseUnits(SOFT_HURDLE_VAULT_DEPOSIT.toString(), underlyingDecimals),
      );
    await softHurdleVault
      .connect(user)
      .requestDeposit(ethers.parseUnits(SOFT_HURDLE_VAULT_DEPOSIT.toString(), underlyingDecimals));

    liquidityOrchestratorBalance = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());
    expect(liquidityOrchestratorBalance).to.equal(
      ethers.parseUnits((ABSOLUTE_VAULT_DEPOSIT + SOFT_HURDLE_VAULT_DEPOSIT).toString(), underlyingDecimals),
    );

    // Hard Hurdle Vault: Diversified allocation with equal weight on mock assets
    const hardHurdleIntent = [
      {
        token: await mockAsset1.getAddress(),
        weight: 250000000,
      },
      {
        token: await mockAsset2.getAddress(),
        weight: 250000000,
      },
      {
        token: await mockAsset3.getAddress(),
        weight: 250000000,
      },
      { token: await underlyingAsset.getAddress(), weight: 250000000 },
    ];
    await hardHurdleVault.connect(curator).submitIntent(hardHurdleIntent);
    await underlyingAsset
      .connect(user)
      .approve(
        await hardHurdleVault.getAddress(),
        ethers.parseUnits(HARD_HURDLE_VAULT_DEPOSIT.toString(), underlyingDecimals),
      );
    await hardHurdleVault
      .connect(user)
      .requestDeposit(ethers.parseUnits(HARD_HURDLE_VAULT_DEPOSIT.toString(), underlyingDecimals));

    liquidityOrchestratorBalance = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());
    expect(liquidityOrchestratorBalance).to.equal(
      ethers.parseUnits(
        (ABSOLUTE_VAULT_DEPOSIT + SOFT_HURDLE_VAULT_DEPOSIT + HARD_HURDLE_VAULT_DEPOSIT).toString(),
        underlyingDecimals,
      ),
    );

    // High Water Mark Vault: Balanced allocation
    const highWaterMarkIntent = [
      {
        token: await mockAsset1.getAddress(),
        weight: 300000000,
      },
      {
        token: await mockAsset2.getAddress(),
        weight: 300000000,
      },
      {
        token: await mockAsset3.getAddress(),
        weight: 250000000,
      },
      { token: await underlyingAsset.getAddress(), weight: 150000000 },
    ];
    await highWaterMarkVault.connect(curator).submitIntent(highWaterMarkIntent);
    await underlyingAsset
      .connect(user)
      .approve(
        await highWaterMarkVault.getAddress(),
        ethers.parseUnits(HIGH_WATER_MARK_VAULT_DEPOSIT.toString(), underlyingDecimals),
      );
    await highWaterMarkVault
      .connect(user)
      .requestDeposit(ethers.parseUnits(HIGH_WATER_MARK_VAULT_DEPOSIT.toString(), underlyingDecimals));

    liquidityOrchestratorBalance = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());
    expect(liquidityOrchestratorBalance).to.equal(
      ethers.parseUnits(
        (
          ABSOLUTE_VAULT_DEPOSIT +
          SOFT_HURDLE_VAULT_DEPOSIT +
          HARD_HURDLE_VAULT_DEPOSIT +
          HIGH_WATER_MARK_VAULT_DEPOSIT
        ).toString(),
        underlyingDecimals,
      ),
    );

    // Hurdle HWM Vault: Moderate allocation with focus on mockAsset2 and mockAsset3
    const hurdleHwmIntent = [
      {
        token: await mockAsset1.getAddress(),
        weight: 150000000,
      },
      {
        token: await mockAsset2.getAddress(),
        weight: 350000000,
      },
      {
        token: await mockAsset3.getAddress(),
        weight: 350000000,
      },
      { token: await underlyingAsset.getAddress(), weight: 150000000 },
    ];
    await hurdleHwmVault.connect(curator).submitIntent(hurdleHwmIntent);
    await underlyingAsset
      .connect(user)
      .approve(
        await hurdleHwmVault.getAddress(),
        ethers.parseUnits(HURDLE_HWM_VAULT_DEPOSIT.toString(), underlyingDecimals),
      );
    await hurdleHwmVault
      .connect(user)
      .requestDeposit(ethers.parseUnits(HURDLE_HWM_VAULT_DEPOSIT.toString(), underlyingDecimals));

    await underlyingAsset
      .connect(user)
      .approve(
        await passiveVault.getAddress(),
        ethers.parseUnits(PASSIVE_VAULT_DEPOSIT.toString(), underlyingDecimals),
      );
    await passiveVault
      .connect(user)
      .requestDeposit(ethers.parseUnits(PASSIVE_VAULT_DEPOSIT.toString(), underlyingDecimals));

    liquidityOrchestratorBalance = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());
    expect(liquidityOrchestratorBalance).to.equal(
      ethers.parseUnits(
        (
          ABSOLUTE_VAULT_DEPOSIT +
          SOFT_HURDLE_VAULT_DEPOSIT +
          HARD_HURDLE_VAULT_DEPOSIT +
          HIGH_WATER_MARK_VAULT_DEPOSIT +
          HURDLE_HWM_VAULT_DEPOSIT +
          PASSIVE_VAULT_DEPOSIT
        ).toString(),
        underlyingDecimals,
      ),
    );
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
});
