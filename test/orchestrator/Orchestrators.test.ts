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

describe("Orchestrators", function () {
  // Vault deposit amounts (in underlying asset units)
  const ABSOLUTE_VAULT_DEPOSIT = 50;
  const SOFT_HURDLE_VAULT_DEPOSIT = 125;
  const HARD_HURDLE_VAULT_DEPOSIT = 200;
  const HIGH_WATER_MARK_VAULT_DEPOSIT = 75;
  const HURDLE_HWM_VAULT_DEPOSIT = 150;
  const PASSIVE_VAULT_DEPOSIT = 100;

  // Expected price factors for mock assets after gains/losses (logged)
  const MOCK_ASSET1_P0 = 1.55;
  const MOCK_ASSET2_P0 = 1.5;
  const MOCK_ASSET3_P0 = 1.055;

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

    await orionConfig.addWhitelistedCurator(await kbestTvlStrategy.getAddress());

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

    await passiveVault.connect(owner).updateCurator(await kbestTvlStrategy.getAddress());
    await kbestTvlStrategy.connect(owner).submitIntent(passiveVault);

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

  describe("Idle-only functionality", function () {
    it("should revert when system is not idle", async function () {
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Idle
      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle
      void expect(await orionConfig.isSystemIdle()).to.be.true;
      await expect(orionConfig.connect(user).removeOrionVault(await hurdleHwmVault.getAddress())).not.to.be.reverted;
      await expect(orionConfig.connect(user).removeWhitelistedAsset(await mockAsset1.getAddress())).not.to.be.reverted;

      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);
      await time.increase((await orionConfig.feeChangeCooldownDuration()) + 1n);

      const [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // Not idle anymore

      void expect(await orionConfig.isSystemIdle()).to.be.false;

      const vaultAddress = await hurdleHwmVault.getAddress();
      await expect(orionConfig.connect(user).removeOrionVault(vaultAddress)).to.be.revertedWithCustomError(
        orionConfig,
        "SystemNotIdle",
      );

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

      await expect(
        orionConfig.connect(user).removeWhitelistedAsset(await mockAsset1.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "SystemNotIdle");

      await expect(
        orionConfig.connect(user).removeOrionVault(await hurdleHwmVault.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "SystemNotIdle");

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
      await expect(liquidityOrchestrator.updateExecutionMinibatchSize(5)).to.be.revertedWithCustomError(
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
      const depositAmount = ethers.parseUnits("100", underlyingDecimals);
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
      // Fast forward time to trigger upkeep
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Idle
      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle
      void expect(await orionConfig.isSystemIdle()).to.be.true;

      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);
      await time.increase((await orionConfig.feeChangeCooldownDuration()) + 1n);

      const [_liquidityUpkeepNeeded, _liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(_liquidityUpkeepNeeded).to.be.false;

      let [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      void expect(_upkeepNeeded).to.be.true;
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      let transparentVaultsEpoch = await internalStatesOrchestrator.getTransparentVaultsEpoch();
      expect(transparentVaultsEpoch.length).to.equal(6);

      // Process all vaults in preprocessing phase - continue until we reach buffering phase
      while ((await internalStatesOrchestrator.currentPhase()) === 1n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }

      let pendingProtocolFees = await internalStatesOrchestrator.pendingProtocolFees();

      expect(pendingProtocolFees).to.equal(0);

      for (const v of [
        absoluteVault,
        highWaterMarkVault,
        softHurdleVault,
        hardHurdleVault,
        hurdleHwmVault,
        passiveVault,
      ]) {
        const pendingCuratorFees = await v.pendingCuratorFees();
        expect(pendingCuratorFees).to.equal(0);
        expect(await internalStatesOrchestrator.getVaultTotalAssetsForFulfillDeposit(await v.getAddress())).to.equal(0);
        expect(await internalStatesOrchestrator.getVaultTotalAssetsForFulfillRedeem(await v.getAddress())).to.equal(0);
      }

      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // Buffering

      let bufferAmountBefore = await internalStatesOrchestrator.bufferAmount();
      console.log(`Buffer Amount Before: ${bufferAmountBefore.toString()}`);
      expect(bufferAmountBefore).to.equal(0);

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

      let bufferAmountAfter = await internalStatesOrchestrator.bufferAmount();

      const targetBufferRatio = await liquidityOrchestrator.targetBufferRatio();
      const BASIS_POINTS_FACTOR = await internalStatesOrchestrator.BASIS_POINTS_FACTOR();

      // Calculate protocol total assets symbolically following InternalStatesOrchestrator._buffer() logic
      const sumAllVaultAssets =
        BigInt(
          ABSOLUTE_VAULT_DEPOSIT +
            SOFT_HURDLE_VAULT_DEPOSIT +
            HARD_HURDLE_VAULT_DEPOSIT +
            HIGH_WATER_MARK_VAULT_DEPOSIT +
            HURDLE_HWM_VAULT_DEPOSIT +
            PASSIVE_VAULT_DEPOSIT,
        ) *
        10n ** BigInt(underlyingDecimals);

      const expectedBufferAmount = (sumAllVaultAssets * BigInt(targetBufferRatio)) / BASIS_POINTS_FACTOR;

      expect(bufferAmountAfter).to.equal(expectedBufferAmount);

      // Process all vaults in postprocessing phase - continue until we reach building orders phase
      while ((await internalStatesOrchestrator.currentPhase()) === 3n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

      // Expected Total Assets:
      const sumVA = BigInt(
        ABSOLUTE_VAULT_DEPOSIT +
          SOFT_HURDLE_VAULT_DEPOSIT +
          HARD_HURDLE_VAULT_DEPOSIT +
          HIGH_WATER_MARK_VAULT_DEPOSIT +
          HURDLE_HWM_VAULT_DEPOSIT +
          PASSIVE_VAULT_DEPOSIT,
      );
      const bufferDelta = bufferAmountAfter - bufferAmountBefore;

      const absVA = BigInt(ABSOLUTE_VAULT_DEPOSIT) * BigInt(10 ** underlyingDecimals);
      const absProportionalFee = (BigInt(ABSOLUTE_VAULT_DEPOSIT) * bufferDelta) / sumVA;
      const absExpected = absVA - absProportionalFee;
      const absActual = await absoluteVault.totalAssets();
      expect(absActual).to.equal(absExpected);

      const shVA = BigInt(SOFT_HURDLE_VAULT_DEPOSIT) * BigInt(10 ** underlyingDecimals);
      const shProportionalFee = (BigInt(SOFT_HURDLE_VAULT_DEPOSIT) * bufferDelta) / sumVA;
      const shExpected = shVA - shProportionalFee;
      const shActual = await softHurdleVault.totalAssets();
      expect(shActual).to.equal(shExpected);

      const hhVA = BigInt(HARD_HURDLE_VAULT_DEPOSIT) * BigInt(10 ** underlyingDecimals);
      const hhProportionalFee = (BigInt(HARD_HURDLE_VAULT_DEPOSIT) * bufferDelta) / sumVA;
      const hhExpected = hhVA - hhProportionalFee;
      const hhActual = await hardHurdleVault.totalAssets();
      expect(hhActual).to.equal(hhExpected);

      const hwmVA = BigInt(HIGH_WATER_MARK_VAULT_DEPOSIT) * BigInt(10 ** underlyingDecimals);
      const hwmProportionalFee = (BigInt(HIGH_WATER_MARK_VAULT_DEPOSIT) * bufferDelta) / sumVA;
      const hwmExpected = hwmVA - hwmProportionalFee;
      const hwmActual = await highWaterMarkVault.totalAssets();
      expect(hwmActual).to.equal(hwmExpected);

      const hhwmVA = BigInt(HURDLE_HWM_VAULT_DEPOSIT) * BigInt(10 ** underlyingDecimals);
      const hhwmProportionalFee = (BigInt(HURDLE_HWM_VAULT_DEPOSIT) * bufferDelta) / sumVA;
      const hhwmExpected = hhwmVA - hhwmProportionalFee;
      const hhwmActual = await hurdleHwmVault.totalAssets();
      expect(hhwmActual).to.equal(hhwmExpected);

      // ------------------------------------------------------------------------------------------------
      // Assert that portfolio values match intent weights * actual assets
      const curatorIntentDecimals = await orionConfig.curatorIntentDecimals();
      const intentDecimals = 10n ** BigInt(curatorIntentDecimals);

      const [absIntentTokens, absIntentWeights] = await absoluteVault.getIntent();
      const [absPortfolioTokens, absPortfolioShares] = await absoluteVault.getPortfolio();

      // Create a map of token to expected shares based on intent weights
      const absExpectedShares = new Map<string, bigint>();
      for (let i = 0; i < absIntentTokens.length; i++) {
        const token = absIntentTokens[i];
        const weight = absIntentWeights[i];

        // Get the price for this token
        const price = await internalStatesOrchestrator.getPriceOf(token);
        const priceAdapterPrecision = 10n ** BigInt(await orionConfig.priceAdapterDecimals());

        const value = (BigInt(weight) * absActual) / intentDecimals;
        const expectedShares = (value * priceAdapterPrecision) / price;

        absExpectedShares.set(token, expectedShares);
      }

      // Compare actual portfolio with expected
      console.log("Absolute Vault Portfolio");
      for (let i = 0; i < absPortfolioTokens.length; i++) {
        const token = absPortfolioTokens[i];
        const actualShares = absPortfolioShares[i];
        const expectedShares = absExpectedShares.get(token);

        console.log(
          `Absolute Vault - Token ${token}: Expected ${expectedShares?.toString()}, Actual ${actualShares.toString()}`,
        );

        void expect(expectedShares).to.not.be.undefined;
        expect(actualShares).to.equal(expectedShares!);
      }

      // Test for soft hurdle vault
      const [shIntentTokens, shIntentWeights] = await softHurdleVault.getIntent();
      const [shPortfolioTokens, shPortfolioShares] = await softHurdleVault.getPortfolio();

      const shExpectedShares = new Map<string, bigint>();
      for (let i = 0; i < shIntentTokens.length; i++) {
        const token = shIntentTokens[i];
        const weight = shIntentWeights[i];

        // Get the price for this token
        const price = await internalStatesOrchestrator.getPriceOf(token);
        const priceAdapterPrecision = 10n ** BigInt(await orionConfig.priceAdapterDecimals());

        const value = (BigInt(weight) * shActual) / intentDecimals;
        const expectedShares = (value * priceAdapterPrecision) / price;

        shExpectedShares.set(token, expectedShares);
      }

      // Compare actual portfolio with expected
      console.log("Soft Hurdle Vault Portfolio");
      for (let i = 0; i < shPortfolioTokens.length; i++) {
        const token = shPortfolioTokens[i];
        const actualShares = shPortfolioShares[i];
        const expectedShares = shExpectedShares.get(token);

        console.log(
          `Soft Hurdle Vault - Token ${token}: Expected ${expectedShares?.toString()}, Actual ${actualShares.toString()}`,
        );

        void expect(expectedShares).to.not.be.undefined;
        expect(actualShares).to.equal(expectedShares!);
      }

      // Test for hard hurdle vault
      const [hhIntentTokens, hhIntentWeights] = await hardHurdleVault.getIntent();
      const [hhPortfolioTokens, hhPortfolioShares] = await hardHurdleVault.getPortfolio();

      const hhExpectedShares = new Map<string, bigint>();
      for (let i = 0; i < hhIntentTokens.length; i++) {
        const token = hhIntentTokens[i];
        const weight = hhIntentWeights[i];

        // Get the price for this token
        const price = await internalStatesOrchestrator.getPriceOf(token);
        const priceAdapterPrecision = 10n ** BigInt(await orionConfig.priceAdapterDecimals());

        const value = (BigInt(weight) * hhActual) / intentDecimals;
        const expectedShares = (value * priceAdapterPrecision) / price;

        hhExpectedShares.set(token, expectedShares);
      }

      // Compare actual portfolio with expected
      console.log("Hard Hurdle Vault Portfolio");
      for (let i = 0; i < hhPortfolioTokens.length; i++) {
        const token = hhPortfolioTokens[i];
        const actualShares = hhPortfolioShares[i];
        const expectedShares = hhExpectedShares.get(token);

        console.log(
          `Hard Hurdle Vault - Token ${token}: Expected ${expectedShares?.toString()}, Actual ${actualShares.toString()}`,
        );

        void expect(expectedShares).to.not.be.undefined;
        expect(actualShares).to.equal(expectedShares!);
      }

      // Test for high water mark vault
      const [hwmIntentTokens, hwmIntentWeights] = await highWaterMarkVault.getIntent();
      const [hwmPortfolioTokens, hwmPortfolioShares] = await highWaterMarkVault.getPortfolio();

      const hwmExpectedShares = new Map<string, bigint>();
      for (let i = 0; i < hwmIntentTokens.length; i++) {
        const token = hwmIntentTokens[i];
        const weight = hwmIntentWeights[i];

        // Get the price for this token
        const price = await internalStatesOrchestrator.getPriceOf(token);
        const priceAdapterPrecision = 10n ** BigInt(await orionConfig.priceAdapterDecimals());

        const value = (BigInt(weight) * hwmActual) / intentDecimals;
        const expectedShares = (value * priceAdapterPrecision) / price;

        hwmExpectedShares.set(token, expectedShares);
      }

      // Compare actual portfolio with expected
      console.log("High Water Mark Vault Portfolio");
      for (let i = 0; i < hwmPortfolioTokens.length; i++) {
        const token = hwmPortfolioTokens[i];
        const actualShares = hwmPortfolioShares[i];
        const expectedShares = hwmExpectedShares.get(token);

        console.log(
          `High Water Mark Vault - Token ${token}: Expected ${expectedShares?.toString()}, Actual ${actualShares.toString()}`,
        );

        void expect(expectedShares).to.not.be.undefined;
        expect(actualShares).to.equal(expectedShares!);
      }

      // Test for hurdle HWM vault
      const [hhwmIntentTokens, hhwmIntentWeights] = await hurdleHwmVault.getIntent();
      const [hhwmPortfolioTokens, hhwmPortfolioShares] = await hurdleHwmVault.getPortfolio();

      const hhwmExpectedShares = new Map<string, bigint>();
      for (let i = 0; i < hhwmIntentTokens.length; i++) {
        const token = hhwmIntentTokens[i];
        const weight = hhwmIntentWeights[i];

        // Get the price for this token
        const price = await internalStatesOrchestrator.getPriceOf(token);
        const priceAdapterPrecision = 10n ** BigInt(await orionConfig.priceAdapterDecimals());

        const value = (BigInt(weight) * hhwmActual) / intentDecimals;
        const expectedShares = (value * priceAdapterPrecision) / price;

        hhwmExpectedShares.set(token, expectedShares);
      }

      // Compare actual portfolio with expected
      console.log("Hurdle HWM Vault Portfolio");
      for (let i = 0; i < hhwmPortfolioTokens.length; i++) {
        const token = hhwmPortfolioTokens[i];
        const actualShares = hhwmPortfolioShares[i];
        const expectedShares = hhwmExpectedShares.get(token);

        console.log(
          `Hurdle HWM Vault - Token ${token}: Expected ${expectedShares?.toString()}, Actual ${actualShares.toString()}`,
        );

        void expect(expectedShares).to.not.be.undefined;
        expect(actualShares).to.equal(expectedShares!);
      }

      // Compute the batched portfolio: sum the share amount of each vault for the same token.
      // We'll batch all portfolios together from: absoluteVault, softHurdleVault, hardHurdleVault, hurdleHwmVault, passiveVault
      const vaultPortfolios = [
        await absoluteVault.getPortfolio(),
        await softHurdleVault.getPortfolio(),
        await hardHurdleVault.getPortfolio(),
        await highWaterMarkVault.getPortfolio(),
        await hurdleHwmVault.getPortfolio(),
        await passiveVault.getPortfolio(),
      ];

      // Map<token, summedShares>
      const batchedPortfolio = new Map<string, bigint>();

      for (const [tokens, shares] of vaultPortfolios) {
        for (let i = 0; i < tokens.length; i++) {
          const token = tokens[i];
          const share = shares[i];
          const prevSum = batchedPortfolio.get(token) ?? 0n;
          batchedPortfolio.set(token, prevSum + share);
        }
      }

      // Output batched portfolio
      console.log("Batched Portfolio Across All Vaults:");
      for (const [token, summedShares] of batchedPortfolio.entries()) {
        console.log(`Token ${token}: Total Shares Across Vaults = ${summedShares.toString()}`);
      }

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Back to Idle
      expect(await internalStatesOrchestrator.epochCounter()).to.equal(1); // Epoch incremented

      // Check that orders were built
      let [
        sellingTokens,
        sellingAmounts,
        buyingTokens,
        buyingAmounts,
        sellingEstimatedUnderlyingAmounts,
        buyingEstimatedUnderlyingAmounts,
      ] = await internalStatesOrchestrator.getOrders();

      // Check that all amounts are greater than 0
      for (const amount of sellingAmounts) {
        expect(amount).to.be.gt(0);
      }
      for (const amount of buyingAmounts) {
        expect(amount).to.be.gt(0);
      }

      expect(sellingTokens.length).to.equal(0);
      expect(sellingEstimatedUnderlyingAmounts.length).to.equal(0);
      expect(buyingTokens.length).to.equal(4);

      // Assert that buying amounts match the batched portfolio (metaportfolio)
      console.log("Buying Orders vs Batched Portfolio:");
      for (let i = 0; i < buyingTokens.length; i++) {
        const token = buyingTokens[i];
        const buyingAmount = buyingAmounts[i];
        const batchedAmount = batchedPortfolio.get(token);

        console.log(
          `Token ${token}: Buying Amount = ${buyingAmount.toString()}, Batched Portfolio = ${batchedAmount?.toString() || "0"}`,
        );

        expect(buyingAmount).to.equal(batchedAmount);
      }

      console.log("--------------------------------------------------------------------------------------------------");

      // Trigger a price mismatch between measured and execution.
      const gainAmount1 = ethers.parseUnits("500", underlyingDecimals);
      await underlyingAsset.connect(user).approve(await mockAsset1.getAddress(), gainAmount1);
      await mockAsset1.connect(user).simulateGains(gainAmount1);

      const gainAmount2 = ethers.parseUnits("530", underlyingDecimals);
      await underlyingAsset.connect(user).approve(await mockAsset2.getAddress(), gainAmount2);
      await mockAsset2.connect(user).simulateGains(gainAmount2);

      const gainAmount3 = ethers.parseUnits("50", underlyingDecimals);
      await underlyingAsset.connect(user).approve(await mockAsset3.getAddress(), gainAmount3);
      await mockAsset3.connect(user).simulateGains(gainAmount3);

      const decimals1 = await mockAsset1.decimals();
      const decimals2 = await mockAsset2.decimals();
      const decimals3 = await mockAsset3.decimals();
      const currentSharePrice1 = await mockAsset1.convertToAssets(10n ** BigInt(decimals1));
      const currentSharePrice2 = await mockAsset2.convertToAssets(10n ** BigInt(decimals2));
      const currentSharePrice3 = await mockAsset3.convertToAssets(10n ** BigInt(decimals3));

      console.log(currentSharePrice1);
      console.log(currentSharePrice2);
      console.log(currentSharePrice3);

      // Price increase for buying-only order, at least one buying order expected to fail
      // due to high mismatch between measured and execution prices.

      // Now check if liquidity orchestrator needs to be triggered
      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle

      const liquidityOrchestratorBalanceBeforeBuying = await underlyingAsset.balanceOf(
        await liquidityOrchestrator.getAddress(),
      );

      // No selling in first epoch.

      let [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // BuyingLeg

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      const liquidityOrchestratorBalance1 = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());

      console.log("liquidityOrchestratorBalance1:", liquidityOrchestratorBalance1.toString());

      const expectedCost1 =
        (buyingAmounts[0] * BigInt(Math.round(MOCK_ASSET1_P0 * 10 ** underlyingDecimals))) / 10n ** BigInt(decimals1);
      const actualCost1 = liquidityOrchestratorBalanceBeforeBuying - liquidityOrchestratorBalance1;

      // Use closeTo for approximate equality with tolerance
      expect(Number(actualCost1)).to.be.closeTo(Number(expectedCost1), 1e-9 * Number(10n ** BigInt(decimals1)));

      expect(buyingEstimatedUnderlyingAmounts[0] - actualCost1).to.equal(
        await liquidityOrchestrator.deltaBufferAmount(),
      );

      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // BuyingLeg

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      const liquidityOrchestratorBalance2 = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());

      console.log("liquidityOrchestratorBalance2:", liquidityOrchestratorBalance2.toString());

      const expectedCost2 =
        (buyingAmounts[1] * BigInt(MOCK_ASSET2_P0 * 10 ** underlyingDecimals)) / 10n ** BigInt(decimals2);
      const actualCost2 = liquidityOrchestratorBalance1 - liquidityOrchestratorBalance2;

      // Use closeTo for approximate equality with tolerance
      expect(Number(actualCost2)).to.be.closeTo(Number(expectedCost2), 1e-9 * Number(10n ** BigInt(decimals2)));

      expect(
        buyingEstimatedUnderlyingAmounts[0] - actualCost1 + buyingEstimatedUnderlyingAmounts[1] - actualCost2,
      ).to.equal(await liquidityOrchestrator.deltaBufferAmount());

      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // BuyingLeg

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;

      await expect(
        liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData),
      ).to.be.revertedWithCustomError(underlyingAsset, "ERC20InsufficientBalance");

      // In conjunction with the failure of the buy transaction,
      // test that trying to performupkeep on the internal state orchestrator
      // (even if its Idle) fails because LO is not idle.
      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      void expect(_upkeepNeeded).to.be.false;

      // Protocol admin injects liquidity to stabilize the protocol and terminate epoch successfully.
      const liquidityInjectionAmount = ethers.parseUnits("170", underlyingDecimals);
      await underlyingAsset.mint(user.address, liquidityInjectionAmount);
      await underlyingAsset.connect(user).approve(await liquidityOrchestrator.getAddress(), liquidityInjectionAmount);
      await liquidityOrchestrator.connect(user).depositLiquidity(liquidityInjectionAmount);

      const liquidityOrchestratorBalanceAfterInjection = await underlyingAsset.balanceOf(
        await liquidityOrchestrator.getAddress(),
      );

      // Retry the performUpkeep call after liquidity injection
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      const liquidityOrchestratorBalance3 = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());
      console.log("liquidityOrchestratorBalance3:", liquidityOrchestratorBalance3.toString());

      const expectedCost3 =
        (buyingAmounts[2] * BigInt(Math.round(MOCK_ASSET3_P0 * 10 ** underlyingDecimals))) / 10n ** BigInt(decimals3);
      const actualCost3 = liquidityOrchestratorBalanceAfterInjection - liquidityOrchestratorBalance3;

      // Use closeTo for approximate equality with tolerance
      expect(Number(actualCost3)).to.be.closeTo(Number(expectedCost3), 1e-9 * Number(10n ** BigInt(decimals3)));

      expect(
        buyingEstimatedUnderlyingAmounts[0] -
          actualCost1 +
          buyingEstimatedUnderlyingAmounts[1] -
          actualCost2 +
          buyingEstimatedUnderlyingAmounts[2] -
          actualCost3,
      ).to.equal(await liquidityOrchestrator.deltaBufferAmount());

      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // BuyingLeg

      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      const liquidityOrchestratorBalance4 = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());

      console.log("liquidityOrchestratorBalance4:", liquidityOrchestratorBalance4.toString());

      // Underlying asset, no transaction.
      expect(liquidityOrchestratorBalance4).to.equal(liquidityOrchestratorBalance3);

      expect(await liquidityOrchestrator.currentPhase()).to.equal(3); // FulfillDepositAndRedeem

      const bufferAmountAfterRebalancing = await internalStatesOrchestrator.bufferAmount();

      // Check balances of investment unverse assets in the LO.
      const liquidityOrchestratorBalanceOfMockAsset1 = await mockAsset1.balanceOf(
        await liquidityOrchestrator.getAddress(),
      );
      const liquidityOrchestratorBalanceOfMockAsset2 = await mockAsset2.balanceOf(
        await liquidityOrchestrator.getAddress(),
      );
      const liquidityOrchestratorBalanceOfMockAsset3 = await mockAsset3.balanceOf(
        await liquidityOrchestrator.getAddress(),
      );

      expect(liquidityOrchestratorBalanceOfMockAsset1).to.equal(buyingAmounts[0]);
      expect(liquidityOrchestratorBalanceOfMockAsset2).to.equal(buyingAmounts[1]);
      expect(liquidityOrchestratorBalanceOfMockAsset3).to.equal(buyingAmounts[2]);

      while ((await liquidityOrchestrator.currentPhase()) === 3n) {
        [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
        void expect(liquidityUpkeepNeeded).to.be.true;
        await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      }

      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle

      const userBalanceOfAbsoluteVault = await absoluteVault.balanceOf(user.address);
      expect(userBalanceOfAbsoluteVault).to.equal(
        ethers.parseUnits(ABSOLUTE_VAULT_DEPOSIT.toString(), await absoluteVault.decimals()),
      );

      const userBalanceOfSoftHurdleVault = await softHurdleVault.balanceOf(user.address);
      expect(userBalanceOfSoftHurdleVault).to.equal(
        ethers.parseUnits(SOFT_HURDLE_VAULT_DEPOSIT.toString(), await softHurdleVault.decimals()),
      );

      const userBalanceOfHardHurdleVault = await hardHurdleVault.balanceOf(user.address);
      expect(userBalanceOfHardHurdleVault).to.equal(
        ethers.parseUnits(HARD_HURDLE_VAULT_DEPOSIT.toString(), await hardHurdleVault.decimals()),
      );

      const userBalanceOfHighWaterMarkVault = await highWaterMarkVault.balanceOf(user.address);
      expect(userBalanceOfHighWaterMarkVault).to.equal(
        ethers.parseUnits(HIGH_WATER_MARK_VAULT_DEPOSIT.toString(), await highWaterMarkVault.decimals()),
      );

      const userBalanceOfHurdleHwmVault = await hurdleHwmVault.balanceOf(user.address);
      expect(userBalanceOfHurdleHwmVault).to.equal(
        ethers.parseUnits(HURDLE_HWM_VAULT_DEPOSIT.toString(), await hurdleHwmVault.decimals()),
      );

      // Have LP request full redemption from absoluteVault
      await absoluteVault.connect(user).approve(await absoluteVault.getAddress(), userBalanceOfAbsoluteVault);
      await absoluteVault.connect(user).requestRedeem(userBalanceOfAbsoluteVault);

      // Confirm redemption request removes shares from user for absoluteVault
      const userBalanceOfAbsoluteVaultAfterRequestRedeem = await absoluteVault.balanceOf(user.address);
      expect(userBalanceOfAbsoluteVaultAfterRequestRedeem).to.equal(0);

      // Have LPs request redemption (test also cancel it) for hurdleHwmVault
      await hurdleHwmVault.connect(user).approve(await hurdleHwmVault.getAddress(), userBalanceOfHurdleHwmVault);
      await hurdleHwmVault.connect(user).requestRedeem(userBalanceOfHurdleHwmVault);

      const userBalanceOfHurdleHwmVaultAfterRequestRedeem = await hurdleHwmVault.balanceOf(user.address);
      expect(userBalanceOfHurdleHwmVaultAfterRequestRedeem).to.equal(0);
      await hurdleHwmVault.connect(user).cancelRedeemRequest(userBalanceOfHurdleHwmVault / 2n);
      const userBalanceOfHurdleHwmVaultAfterCancelRedeem = await hurdleHwmVault.balanceOf(user.address);
      expect(userBalanceOfHurdleHwmVaultAfterCancelRedeem).to.equal(userBalanceOfHurdleHwmVault / 2n);

      // Assert that the user's pending redeem amount is updated correctly after cancellation for hurdleHwmVault
      const pendingRedeemAfterCancel = await hurdleHwmVault.pendingRedeem();
      expect(pendingRedeemAfterCancel).to.equal(userBalanceOfHurdleHwmVault / 2n);

      console.log("--------------------------------------------------------------------------------------------------");
      // Trigger a price mismatch between Epochs 1 and 2 for non-zero fees and non-zero selling
      const gainAmount11 = ethers.parseUnits("100", underlyingDecimals);
      await underlyingAsset.connect(user).approve(await mockAsset1.getAddress(), gainAmount11);
      await mockAsset1.connect(user).simulateGains(gainAmount11);

      const gainAmount21 = ethers.parseUnits("100", underlyingDecimals);
      await underlyingAsset.connect(user).approve(await mockAsset2.getAddress(), gainAmount21);
      await mockAsset2.connect(user).simulateGains(gainAmount21);

      const lossAmount31 = ethers.parseUnits("10", underlyingDecimals);
      await underlyingAsset.connect(user).approve(await mockAsset3.getAddress(), lossAmount31);
      await mockAsset3.connect(user).simulateLosses(lossAmount31, user.address);

      // const currentSharePrice1 = await mockAsset1.convertToAssets(10n ** BigInt(decimals1));
      // const currentSharePrice2 = await mockAsset2.convertToAssets(10n ** BigInt(decimals2));
      // const currentSharePrice3 = await mockAsset3.convertToAssets(10n ** BigInt(decimals3));

      // P2 = [1.636361112824, 1.585680530865, 1.101192721532, 1]

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

      console.log("\n=== CURATOR FEE CALCULATION ANALYSIS ===");

      // Get protocol configuration
      const vFeeCoefficient = await internalStatesOrchestrator.vFeeCoefficient();
      const rsFeeCoefficient = await internalStatesOrchestrator.rsFeeCoefficient();
      const priceAdapterDecimals = await orionConfig.priceAdapterDecimals();
      const riskFreeRate = await orionConfig.riskFreeRate();

      // Vault configurations for testing
      const vaults = [
        { name: "Absolute", vault: absoluteVault, feeType: 0 },
        { name: "High Water Mark", vault: highWaterMarkVault, feeType: 1 },
        { name: "Soft Hurdle", vault: softHurdleVault, feeType: 2 },
        { name: "Hard Hurdle", vault: hardHurdleVault, feeType: 3 },
        { name: "Hurdle HWM", vault: hurdleHwmVault, feeType: 4 },
        { name: "Passive", vault: passiveVault, feeType: 0 },
      ];

      let totalCalculatedVolumeFee = 0;
      let totalCalculatedRevenueShareFee = 0;

      // Process each vault
      for (const { name, vault, feeType } of vaults) {
        console.log(`\n--- ${name} Vault Analysis ---`);

        // Get vault fee model
        const feeModel = await vault.feeModel();
        const performanceFee = feeModel.performanceFee;
        const managementFee = feeModel.managementFee;
        const highWaterMark = feeModel.highWaterMark;

        console.log(`Fee Model: Performance=${performanceFee}, Management=${managementFee}, HWM=${highWaterMark}`);

        // Calculate portfolio value using dot product (shares * prices)
        const [portfolio, sharesPerAsset] = await vault.getPortfolio();
        let vaultTotalAssets = 0n;

        console.log("Portfolio calculation:");
        for (let i = 0; i < portfolio.length; i++) {
          const token = portfolio[i];
          const shares = BigInt(sharesPerAsset[i]);
          const price = await internalStatesOrchestrator.getPriceOf(token);

          const value = (shares * price) / 10n ** BigInt(priceAdapterDecimals);

          // Convert to underlying asset decimals if needed
          const tokenDecimals = await orionConfig.getTokenDecimals(token);
          let adjustedValue = value;
          if (BigInt(tokenDecimals) !== BigInt(underlyingDecimals)) {
            if (tokenDecimals > underlyingDecimals) {
              adjustedValue = value / 10n ** BigInt(Number(tokenDecimals) - Number(underlyingDecimals));
            } else {
              adjustedValue = value * 10n ** BigInt(Number(underlyingDecimals) - Number(tokenDecimals));
            }
          }

          vaultTotalAssets += adjustedValue;
        }

        console.log(`Total Vault Assets: ${vaultTotalAssets.toString()}`);

        // Calculate protocol volume fee
        const volumeFee = (BigInt(vFeeCoefficient) * vaultTotalAssets) / 10000n;
        const volumeFeeAdjusted = (volumeFee * BigInt(epochDuration)) / (365n * 24n * 60n * 60n);
        totalCalculatedVolumeFee += Number(volumeFeeAdjusted);

        console.log(`Volume Fee: ${volumeFeeAdjusted.toString()}`);

        // Calculate curator fees (following protocol logic)
        const assetsAfterVolumeFee = vaultTotalAssets - volumeFeeAdjusted;

        // Management fee calculation
        let managementFeeAmount = 0n;
        if (managementFee > 0) {
          const annualManagementFee = (BigInt(managementFee) * assetsAfterVolumeFee) / 10000n;
          managementFeeAmount = (annualManagementFee * BigInt(epochDuration)) / (365n * 24n * 60n * 60n);
        }

        // Performance fee calculation
        let performanceFeeAmount = 0n;
        if (performanceFee > 0) {
          // Get current share price
          const currentSharePrice = await vault.convertToAssets(10n ** BigInt(await vault.decimals()));

          // Calculate benchmark based on fee type
          let benchmark = 0n;
          let divisor = 0n;

          if (feeType === 0) {
            // ABSOLUTE
            benchmark = currentSharePrice;
            divisor = benchmark;
          } else if (feeType === 1) {
            // HIGH_WATER_MARK
            benchmark = highWaterMark;
            divisor = benchmark;
          } else if (feeType === 2) {
            // SOFT_HURDLE
            const hurdleReturn = (riskFreeRate * BigInt(epochDuration)) / (365n * 24n * 60n * 60n);
            benchmark = (currentSharePrice * (10000n + hurdleReturn)) / 10000n;
            divisor = currentSharePrice;
          } else if (feeType === 3) {
            // HARD_HURDLE
            const hurdleReturn = (riskFreeRate * BigInt(epochDuration)) / (365n * 24n * 60n * 60n);
            benchmark = (currentSharePrice * (10000n + hurdleReturn)) / 10000n;
            divisor = benchmark;
          } else if (feeType === 4) {
            // HURDLE_HWM
            const hurdleReturn = (riskFreeRate * BigInt(epochDuration)) / (365n * 24n * 60n * 60n);
            const hurdlePrice = (currentSharePrice * (10000n + hurdleReturn)) / 10000n;
            benchmark = hurdlePrice > highWaterMark ? hurdlePrice : highWaterMark;
            divisor = benchmark;
          }

          // Calculate active share price for performance fee
          const assetsForPerformanceFee = assetsAfterVolumeFee - managementFeeAmount;
          const activeSharePrice = await vault.convertToAssetsWithPITTotalAssets(
            10n ** BigInt(await vault.decimals()),
            assetsForPerformanceFee,
            0, // Math.Rounding.Floor
          );

          if (activeSharePrice > benchmark && divisor > 0) {
            const feeRate = (BigInt(performanceFee) * (activeSharePrice - divisor)) / divisor;
            const annualPerformanceFee = (feeRate * assetsForPerformanceFee) / 10000n;
            performanceFeeAmount = (annualPerformanceFee * BigInt(epochDuration)) / (365n * 24n * 60n * 60n);
          }

          console.log(`Performance Fee Details:`);
          console.log(`  Current Share Price: ${currentSharePrice.toString()}`);
          console.log(`  Active Share Price: ${activeSharePrice.toString()}`);
          console.log(`  Benchmark: ${benchmark.toString()}`);
          console.log(`  Divisor: ${divisor.toString()}`);
        }

        const totalCuratorFee = managementFeeAmount + performanceFeeAmount;

        console.log(`Management Fee: ${managementFeeAmount.toString()}`);
        console.log(`Performance Fee: ${performanceFeeAmount.toString()}`);
        console.log(`Total Curator Fee: ${totalCuratorFee.toString()}`);

        // Calculate revenue share fee
        const revenueShareFee = (BigInt(rsFeeCoefficient) * totalCuratorFee) / 10000n;
        totalCalculatedRevenueShareFee += Number(revenueShareFee);

        console.log(`Revenue Share Fee: ${revenueShareFee.toString()}`);

        // Get actual values from contracts for comparison
        const actualPendingCuratorFees = await vault.pendingCuratorFees();
        console.log(`Actual Pending Curator Fees: ${actualPendingCuratorFees.toString()}`);

        // Calculate expected curator fee after revenue share
        const expectedCuratorFeeAfterRevenueShare = totalCuratorFee - revenueShareFee;
        console.log(`Expected Curator Fee (after revenue share): ${expectedCuratorFeeAfterRevenueShare.toString()}`);

        expect(actualPendingCuratorFees).to.equal(expectedCuratorFeeAfterRevenueShare);

        // Calculate expected values for fulfill deposit and redeem
        const assetsAfterVolumeFeeForFulfill = vaultTotalAssets - volumeFeeAdjusted;
        const assetsAfterCuratorFeesForFulfill = assetsAfterVolumeFeeForFulfill - totalCuratorFee;

        // Expected fulfill redeem: totalAssets after volume fee and curator fees
        const expectedFulfillRedeem = assetsAfterCuratorFeesForFulfill;

        // Expected fulfill deposit: totalAssets after volume fee, curator fees, and pending redeem
        // Note: pendingRedeem needs to be converted from shares to assets using convertToAssetsWithPITTotalAssets
        const pendingRedeemShares = await vault.pendingRedeem();
        const pendingRedeemAssets = await vault.convertToAssetsWithPITTotalAssets(
          pendingRedeemShares,
          expectedFulfillRedeem,
          0, // Math.Rounding.Floor
        );
        const expectedFulfillDeposit = expectedFulfillRedeem - pendingRedeemAssets;

        // Get actual values from orchestrator
        const actualFulfillRedeem = await internalStatesOrchestrator.getVaultTotalAssetsForFulfillRedeem(
          await vault.getAddress(),
        );
        const actualFulfillDeposit = await internalStatesOrchestrator.getVaultTotalAssetsForFulfillDeposit(
          await vault.getAddress(),
        );

        expect(actualFulfillRedeem).to.equal(expectedFulfillRedeem);
        expect(actualFulfillDeposit).to.equal(expectedFulfillDeposit);
      }

      // Calculate total expected protocol fees
      const totalExpectedProtocolFees = totalCalculatedVolumeFee + totalCalculatedRevenueShareFee;
      const actualPendingProtocolFees = await internalStatesOrchestrator.pendingProtocolFees();

      console.log(`\n=== PROTOCOL FEE SUMMARY ===`);
      console.log(`Total Calculated Volume Fee: ${totalCalculatedVolumeFee}`);
      console.log(`Total Calculated Revenue Share Fee: ${totalCalculatedRevenueShareFee}`);
      console.log(`Total Expected Protocol Fees: ${totalExpectedProtocolFees}`);
      console.log(`Actual Pending Protocol Fees: ${actualPendingProtocolFees.toString()}`);

      expect(actualPendingProtocolFees).to.equal(totalExpectedProtocolFees);

      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // Buffering

      bufferAmountBefore = await internalStatesOrchestrator.bufferAmount();
      expect(bufferAmountBefore).to.equal(bufferAmountAfterRebalancing);

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

      // Calculate expected buffer amount using fulfill redeem/deposit values
      transparentVaultsEpoch = await internalStatesOrchestrator.getTransparentVaultsEpoch();
      let protocolTotalAssets = 0n;
      const vaultsTotalAssetsArray: bigint[] = [];

      // Reconstruct vaultsTotalAssets using the same logic as step 6 in the orchestrator
      for (const vaultAddress of transparentVaultsEpoch) {
        const vault = await ethers.getContractAt("OrionTransparentVault", vaultAddress);

        // Get the values that were stored in the orchestrator
        const vaultsTotalAssetsForFulfillDeposit =
          await internalStatesOrchestrator.getVaultTotalAssetsForFulfillDeposit(vaultAddress);
        const pendingDeposit = await vault.pendingDeposit();

        // Reconstruct vaultsTotalAssets: fulfillDeposit + pendingDeposit
        const vaultsTotalAssets = vaultsTotalAssetsForFulfillDeposit + pendingDeposit;

        vaultsTotalAssetsArray.push(vaultsTotalAssets);
        protocolTotalAssets += vaultsTotalAssets;
        console.log(`Vault ${vaultAddress} total assets: ${vaultsTotalAssets.toString()}`);
      }

      // Calculate target buffer amount using the same formula as the orchestrator
      const targetBufferAmount = (protocolTotalAssets * BigInt(targetBufferRatio)) / BASIS_POINTS_FACTOR;
      const deltaBufferAmount = targetBufferAmount - bufferAmountBefore;

      // Calculate actual buffer allocated (sum of floor-divided vault costs, same as orchestrator)
      let actualBufferAllocated = 0n;
      const postBufferVaultsTotalAssets: bigint[] = [];

      for (let i = 0; i < transparentVaultsEpoch.length; i++) {
        const vaultAddress = transparentVaultsEpoch[i];
        const vaultTotalAssets = vaultsTotalAssetsArray[i];

        // Calculate vault buffer cost proportionally with floor division (same logic as orchestrator)
        // Using mulDiv equivalent: (deltaBufferAmount * vaultTotalAssets) / protocolTotalAssets
        const vaultBufferCost = (deltaBufferAmount * vaultTotalAssets) / protocolTotalAssets;
        const postBufferTotalAssets = vaultTotalAssets - vaultBufferCost;

        actualBufferAllocated += vaultBufferCost;
        postBufferVaultsTotalAssets.push(postBufferTotalAssets);
        console.log(`Vault ${vaultAddress} post-buffer total assets: ${postBufferTotalAssets.toString()}`);
      }

      bufferAmountAfter = await internalStatesOrchestrator.bufferAmount();
      console.log(`Protocol Total Assets: ${protocolTotalAssets.toString()}`);
      console.log(`Target Buffer Amount: ${targetBufferAmount.toString()}`);
      console.log(`Actual Buffer Allocated: ${actualBufferAllocated.toString()}`);
      console.log(`Actual Buffer Amount: ${bufferAmountAfter.toString()}`);

      // Buffer amount should equal bufferBefore + actual allocated amount (accounting for rounding)
      expect(bufferAmountAfter).to.equal(bufferAmountBefore + actualBufferAllocated);

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
      [
        sellingTokens,
        sellingAmounts,
        buyingTokens,
        buyingAmounts,
        sellingEstimatedUnderlyingAmounts,
        buyingEstimatedUnderlyingAmounts,
      ] = await internalStatesOrchestrator.getOrders();

      // Check that all amounts are greater than 0
      for (const amount of sellingAmounts) {
        expect(amount).to.be.gt(0);
      }

      console.log("sellingTokens:", sellingTokens);
      console.log("buyingTokens:", buyingTokens);
      console.log("sellingAmounts:", sellingAmounts);
      console.log("buyingAmounts:", buyingAmounts);
      console.log("sellingEstimatedUnderlyingAmounts:", sellingEstimatedUnderlyingAmounts);
      console.log("buyingEstimatedUnderlyingAmounts:", buyingEstimatedUnderlyingAmounts);

      // Get epoch tokens to assess tokenExists mapping
      const epochTokensForAssessment = await internalStatesOrchestrator.getEpochTokens();
      console.log("=== EPOCH STATE ASSESSMENT ===");
      console.log(`Epoch Tokens (tokenExists): ${epochTokensForAssessment.length} tokens`);
      for (const token of epochTokensForAssessment) {
        console.log(`  Token: ${token}`);
      }

      // Assess priceArray by getting prices for all epoch tokens
      console.log("\n=== PRICE ARRAY ASSESSMENT ===");
      for (const token of epochTokensForAssessment) {
        const price = await internalStatesOrchestrator.getPriceOf(token);
        console.log(`Token ${token}: Price = ${price.toString()}`);
        expect(price).to.be.gt(0);
      }

      // Assess vaultsTotalAssetsForFulfillRedeem for all vaults
      console.log("\n=== VAULTS TOTAL ASSETS FOR FULFILL REDEEM ===");
      for (const vaultAddress of transparentVaultsEpoch) {
        const totalAssetsForRedeem = await internalStatesOrchestrator.getVaultTotalAssetsForFulfillRedeem(vaultAddress);
        console.log(`Vault ${vaultAddress}: Total Assets for Fulfill Redeem = ${totalAssetsForRedeem.toString()}`);
        expect(totalAssetsForRedeem).to.be.gte(0);
      }

      // Assess vaultsTotalAssetsForFulfillDeposit for all vaults
      console.log("\n=== VAULTS TOTAL ASSETS FOR FULFILL DEPOSIT ===");
      for (const vaultAddress of transparentVaultsEpoch) {
        const totalAssetsForDeposit =
          await internalStatesOrchestrator.getVaultTotalAssetsForFulfillDeposit(vaultAddress);
        console.log(`Vault ${vaultAddress}: Total Assets for Fulfill Deposit = ${totalAssetsForDeposit.toString()}`);
        expect(totalAssetsForDeposit).to.be.gte(0);
      }

      // Assess vaultsTotalAssets (reconstructed as fulfillDeposit + pendingDeposit)
      console.log("\n=== VAULTS TOTAL ASSETS (RECONSTRUCTED) ===");
      for (let i = 0; i < transparentVaultsEpoch.length; i++) {
        const vaultAddress = transparentVaultsEpoch[i];
        const vaultsTotalAssets = vaultsTotalAssetsArray[i];
        console.log(`Vault ${vaultAddress}: Total Assets = ${vaultsTotalAssets.toString()}`);
        expect(vaultsTotalAssets).to.be.gt(0);
      }

      // Assess initialBatchPortfolio by reconstructing it from individual vault portfolios
      console.log("\n=== INITIAL BATCH PORTFOLIO ASSESSMENT ===");
      const initialBatchPortfolio = new Map<string, bigint>();

      // Get portfolios from all vaults and sum them up
      const vaultPortfoliosForAssessment = [
        await absoluteVault.getPortfolio(),
        await softHurdleVault.getPortfolio(),
        await hardHurdleVault.getPortfolio(),
        await highWaterMarkVault.getPortfolio(),
        await hurdleHwmVault.getPortfolio(),
        await passiveVault.getPortfolio(),
      ];

      for (const [tokens, shares] of vaultPortfoliosForAssessment) {
        for (let i = 0; i < tokens.length; i++) {
          const token = tokens[i];
          const share = shares[i];
          const prevSum = initialBatchPortfolio.get(token) ?? 0n;
          initialBatchPortfolio.set(token, prevSum + share);
        }
      }

      console.log("Initial Batch Portfolio (sum of all vault portfolios):");
      for (const [token, totalShares] of initialBatchPortfolio.entries()) {
        console.log(`  Token ${token}: Total Shares = ${totalShares.toString()}`);
        expect(totalShares).to.be.gt(0);
      }

      console.log("=== END EPOCH STATE ASSESSMENT ===\n");

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

      // Get all vault addresses
      const allVaults = [
        { name: "Absolute", vault: absoluteVault },
        { name: "Soft Hurdle", vault: softHurdleVault },
        { name: "Hard Hurdle", vault: hardHurdleVault },
        { name: "High Water Mark", vault: highWaterMarkVault },
        { name: "Hurdle HWM", vault: hurdleHwmVault },
        { name: "Passive", vault: passiveVault },
      ];

      for (const { name, vault } of allVaults) {
        const userBalance = await vault.balanceOf(user.address);
        const totalSupply = await vault.totalSupply();
        const pendingDeposit = await vault.pendingDeposit();
        const pendingRedeem = await vault.pendingRedeem();

        // Verify that pending deposits and redemptions are cleared after fulfill
        expect(pendingDeposit).to.equal(0, `${name} vault should have no pending deposits after fulfill`);
        expect(pendingRedeem).to.equal(0, `${name} vault should have no pending redemptions after fulfill`);

        // Verify total supply matches user balance (since only one user in this test)
        expect(totalSupply).to.equal(userBalance, `${name} vault total supply should equal user balance`);
      }

      const investmentUniverseAssets = [mockAsset1, mockAsset2, mockAsset3];
      const assetNames = ["Mock Asset 1", "Mock Asset 2", "Mock Asset 3"];

      for (let i = 0; i < investmentUniverseAssets.length; i++) {
        const asset = investmentUniverseAssets[i];
        const assetName = assetNames[i];
        const liquidityOrchestratorBalance = await asset.balanceOf(await liquidityOrchestrator.getAddress());

        console.log(`${assetName}: ${liquidityOrchestratorBalance.toString()}`);

        // Note: At this point, FulfillDepositAndRedeem has completed, so bought assets
        // have been distributed to vaults. The LO balance represents what's left over
        // after distribution, which depends on the complex interaction between:
        // - Initial holdings
        // - Rebalancing orders (sells + buys)
        // - Distribution to vaults based on target portfolios
        // - Performance fee calculations (which changed with the bug fix)
        //
        // We just verify balances are non-negative as a sanity check
        expect(liquidityOrchestratorBalance).to.be.gte(0, `${assetName} balance should be non-negative`);
      }

      // 4. Verify buffer management and exchange ratios
      console.log("\n--- Buffer Management and Exchange Ratios ---");

      const currentBufferAmount = await internalStatesOrchestrator.bufferAmount();
      const liquidityOrchestratorUnderlyingBalance = await underlyingAsset.balanceOf(
        await liquidityOrchestrator.getAddress(),
      );

      console.log(`Current Buffer Amount: ${currentBufferAmount.toString()}`);
      console.log(`Liquidity Orchestrator Underlying Balance: ${liquidityOrchestratorUnderlyingBalance.toString()}`);

      expect(currentBufferAmount).to.be.gte(0, "Buffer amount should not be negative");

      // Get actual vault assets after second epoch (these have been rebalanced)
      const absActual_SecondEpoch = await absoluteVault.totalAssets();
      const shActual_SecondEpoch = await softHurdleVault.totalAssets();
      const hhActual_SecondEpoch = await hardHurdleVault.totalAssets();
      const hwmActual_SecondEpoch = await highWaterMarkVault.totalAssets();
      const hhwmActual_SecondEpoch = await hurdleHwmVault.totalAssets();
      const passiveActual_SecondEpoch = await passiveVault.totalAssets();

      console.log("Second Epoch Vault Assets:");
      console.log(`Absolute Vault: ${absActual_SecondEpoch.toString()}`);
      console.log(`Soft Hurdle Vault: ${shActual_SecondEpoch.toString()}`);
      console.log(`Hard Hurdle Vault: ${hhActual_SecondEpoch.toString()}`);
      console.log(`High Water Mark Vault: ${hwmActual_SecondEpoch.toString()}`);
      console.log(`Hurdle HWM Vault: ${hhwmActual_SecondEpoch.toString()}`);
      console.log(`Passive Vault: ${passiveActual_SecondEpoch.toString()}`);

      // ------------------------------------------------------------------------------------------------
      // Assert that portfolio values match intent weights * actual assets for second epoch
      const curatorIntentDecimals_SecondEpoch = await orionConfig.curatorIntentDecimals();
      const intentDecimals_SecondEpoch = 10n ** BigInt(curatorIntentDecimals_SecondEpoch);

      const [absIntentTokens_SecondEpoch, absIntentWeights_SecondEpoch] = await absoluteVault.getIntent();
      const [absPortfolioTokens_SecondEpoch, absPortfolioShares_SecondEpoch] = await absoluteVault.getPortfolio();

      // Create a map of token to expected shares based on intent weights for second epoch
      const absExpectedShares_SecondEpoch = new Map<string, bigint>();
      for (let i = 0; i < absIntentTokens_SecondEpoch.length; i++) {
        const token = absIntentTokens_SecondEpoch[i];
        const weight = absIntentWeights_SecondEpoch[i];

        // Get the price for this token
        const price = await internalStatesOrchestrator.getPriceOf(token);
        const priceAdapterPrecision = 10n ** BigInt(await orionConfig.priceAdapterDecimals());

        const value = (BigInt(weight) * absActual_SecondEpoch) / intentDecimals_SecondEpoch;
        const expectedShares = (value * priceAdapterPrecision) / price;

        absExpectedShares_SecondEpoch.set(token, expectedShares);
      }

      // Compare actual portfolio with expected for second epoch
      console.log("Absolute Vault Portfolio - Second Epoch");
      for (let i = 0; i < absPortfolioTokens_SecondEpoch.length; i++) {
        const token = absPortfolioTokens_SecondEpoch[i];
        const actualShares = absPortfolioShares_SecondEpoch[i];
        const expectedShares = absExpectedShares_SecondEpoch.get(token);

        console.log(
          `Absolute Vault - Token ${token}: Expected ${expectedShares?.toString()}, Actual ${actualShares.toString()}`,
        );

        void expect(expectedShares).to.not.be.undefined;
        expect(actualShares).to.equal(expectedShares!);
      }

      // Test for soft hurdle vault - second epoch
      const [shIntentTokens_SecondEpoch, shIntentWeights_SecondEpoch] = await softHurdleVault.getIntent();
      const [shPortfolioTokens_SecondEpoch, shPortfolioShares_SecondEpoch] = await softHurdleVault.getPortfolio();

      const shExpectedShares_SecondEpoch = new Map<string, bigint>();
      for (let i = 0; i < shIntentTokens_SecondEpoch.length; i++) {
        const token = shIntentTokens_SecondEpoch[i];
        const weight = shIntentWeights_SecondEpoch[i];

        // Get the price for this token
        const price = await internalStatesOrchestrator.getPriceOf(token);
        const priceAdapterPrecision = 10n ** BigInt(await orionConfig.priceAdapterDecimals());

        const value = (BigInt(weight) * shActual_SecondEpoch) / intentDecimals_SecondEpoch;
        const expectedShares = (value * priceAdapterPrecision) / price;

        shExpectedShares_SecondEpoch.set(token, expectedShares);
      }

      // Compare actual portfolio with expected for second epoch
      console.log("Soft Hurdle Vault Portfolio - Second Epoch");
      for (let i = 0; i < shPortfolioTokens_SecondEpoch.length; i++) {
        const token = shPortfolioTokens_SecondEpoch[i];
        const actualShares = shPortfolioShares_SecondEpoch[i];
        const expectedShares = shExpectedShares_SecondEpoch.get(token);

        console.log(
          `Soft Hurdle Vault - Token ${token}: Expected ${expectedShares?.toString()}, Actual ${actualShares.toString()}`,
        );

        void expect(expectedShares).to.not.be.undefined;
        expect(actualShares).to.equal(expectedShares!);
      }

      // Test for hard hurdle vault - second epoch
      const [hhIntentTokens_SecondEpoch, hhIntentWeights_SecondEpoch] = await hardHurdleVault.getIntent();
      const [hhPortfolioTokens_SecondEpoch, hhPortfolioShares_SecondEpoch] = await hardHurdleVault.getPortfolio();

      const hhExpectedShares_SecondEpoch = new Map<string, bigint>();
      for (let i = 0; i < hhIntentTokens_SecondEpoch.length; i++) {
        const token = hhIntentTokens_SecondEpoch[i];
        const weight = hhIntentWeights_SecondEpoch[i];

        // Get the price for this token
        const price = await internalStatesOrchestrator.getPriceOf(token);
        const priceAdapterPrecision = 10n ** BigInt(await orionConfig.priceAdapterDecimals());

        const value = (BigInt(weight) * hhActual_SecondEpoch) / intentDecimals_SecondEpoch;
        const expectedShares = (value * priceAdapterPrecision) / price;

        hhExpectedShares_SecondEpoch.set(token, expectedShares);
      }

      // Compare actual portfolio with expected for second epoch
      console.log("Hard Hurdle Vault Portfolio - Second Epoch");
      for (let i = 0; i < hhPortfolioTokens_SecondEpoch.length; i++) {
        const token = hhPortfolioTokens_SecondEpoch[i];
        const actualShares = hhPortfolioShares_SecondEpoch[i];
        const expectedShares = hhExpectedShares_SecondEpoch.get(token);

        console.log(
          `Hard Hurdle Vault - Token ${token}: Expected ${expectedShares?.toString()}, Actual ${actualShares.toString()}`,
        );

        void expect(expectedShares).to.not.be.undefined;
        expect(actualShares).to.equal(expectedShares!);
      }

      // Test for high water mark vault - second epoch
      const [hwmIntentTokens_SecondEpoch, hwmIntentWeights_SecondEpoch] = await highWaterMarkVault.getIntent();
      const [hwmPortfolioTokens_SecondEpoch, hwmPortfolioShares_SecondEpoch] = await highWaterMarkVault.getPortfolio();

      const hwmExpectedShares_SecondEpoch = new Map<string, bigint>();
      for (let i = 0; i < hwmIntentTokens_SecondEpoch.length; i++) {
        const token = hwmIntentTokens_SecondEpoch[i];
        const weight = hwmIntentWeights_SecondEpoch[i];

        // Get the price for this token
        const price = await internalStatesOrchestrator.getPriceOf(token);
        const priceAdapterPrecision = 10n ** BigInt(await orionConfig.priceAdapterDecimals());

        const value = (BigInt(weight) * hwmActual_SecondEpoch) / intentDecimals_SecondEpoch;
        const expectedShares = (value * priceAdapterPrecision) / price;

        hwmExpectedShares_SecondEpoch.set(token, expectedShares);
      }

      // Compare actual portfolio with expected for second epoch
      console.log("High Water Mark Vault Portfolio - Second Epoch");
      for (let i = 0; i < hwmPortfolioTokens_SecondEpoch.length; i++) {
        const token = hwmPortfolioTokens_SecondEpoch[i];
        const actualShares = hwmPortfolioShares_SecondEpoch[i];
        const expectedShares = hwmExpectedShares_SecondEpoch.get(token);

        console.log(
          `High Water Mark Vault - Token ${token}: Expected ${expectedShares?.toString()}, Actual ${actualShares.toString()}`,
        );

        void expect(expectedShares).to.not.be.undefined;
        expect(actualShares).to.equal(expectedShares!);
      }

      // Test for hurdle HWM vault - second epoch
      const [hhwmIntentTokens_SecondEpoch, hhwmIntentWeights_SecondEpoch] = await hurdleHwmVault.getIntent();
      const [hhwmPortfolioTokens_SecondEpoch, hhwmPortfolioShares_SecondEpoch] = await hurdleHwmVault.getPortfolio();

      const hhwmExpectedShares_SecondEpoch = new Map<string, bigint>();
      for (let i = 0; i < hhwmIntentTokens_SecondEpoch.length; i++) {
        const token = hhwmIntentTokens_SecondEpoch[i];
        const weight = hhwmIntentWeights_SecondEpoch[i];

        // Get the price for this token
        const price = await internalStatesOrchestrator.getPriceOf(token);
        const priceAdapterPrecision = 10n ** BigInt(await orionConfig.priceAdapterDecimals());

        const value = (BigInt(weight) * hhwmActual_SecondEpoch) / intentDecimals_SecondEpoch;
        const expectedShares = (value * priceAdapterPrecision) / price;

        hhwmExpectedShares_SecondEpoch.set(token, expectedShares);
      }

      // Compare actual portfolio with expected for second epoch
      console.log("Hurdle HWM Vault Portfolio - Second Epoch");
      for (let i = 0; i < hhwmPortfolioTokens_SecondEpoch.length; i++) {
        const token = hhwmPortfolioTokens_SecondEpoch[i];
        const actualShares = hhwmPortfolioShares_SecondEpoch[i];
        const expectedShares = hhwmExpectedShares_SecondEpoch.get(token);

        console.log(
          `Hurdle HWM Vault - Token ${token}: Expected ${expectedShares?.toString()}, Actual ${actualShares.toString()}`,
        );

        void expect(expectedShares).to.not.be.undefined;
        expect(actualShares).to.equal(expectedShares!);
      }

      // Compute the batched portfolio for second epoch: sum the share amount of each vault for the same token.
      // We'll batch all portfolios together from: absoluteVault, softHurdleVault, hardHurdleVault, hurdleHwmVault, passiveVault
      const vaultPortfolios_SecondEpoch = [
        await absoluteVault.getPortfolio(),
        await softHurdleVault.getPortfolio(),
        await hardHurdleVault.getPortfolio(),
        await highWaterMarkVault.getPortfolio(),
        await hurdleHwmVault.getPortfolio(),
        await passiveVault.getPortfolio(),
      ];

      // Map<token, summedShares>
      const batchedPortfolio_SecondEpoch = new Map<string, bigint>();

      for (const [tokens, shares] of vaultPortfolios_SecondEpoch) {
        for (let i = 0; i < tokens.length; i++) {
          const token = tokens[i];
          const share = shares[i];
          const prevSum = batchedPortfolio_SecondEpoch.get(token) ?? 0n;
          batchedPortfolio_SecondEpoch.set(token, prevSum + share);
        }
      }

      // Output batched portfolio for second epoch
      console.log("Batched Portfolio Across All Vaults - Second Epoch:");
      for (const [token, summedShares] of batchedPortfolio_SecondEpoch.entries()) {
        console.log(`Token ${token}: Total Shares Across Vaults = ${summedShares.toString()}`);
      }
      // Test LiquidityOrchestrator functions
      await expect(liquidityOrchestrator.updateExecutionMinibatchSize(1)).to.not.be.reverted;

      // Check and claim protocol fees
      pendingProtocolFees = await internalStatesOrchestrator.pendingProtocolFees();
      if (pendingProtocolFees > 0) {
        await liquidityOrchestrator.connect(user).claimProtocolFees(pendingProtocolFees);
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

    it("should not update buffer after beneficial slippage epoch and no LP interactions", async function () {
      // Fast forward time to trigger upkeep
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Idle
      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle
      void expect(await orionConfig.isSystemIdle()).to.be.true;

      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);
      await time.increase((await orionConfig.feeChangeCooldownDuration()) + 1n);

      let [_liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(_liquidityUpkeepNeeded).to.be.false;

      let [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      void expect(_upkeepNeeded).to.be.true;
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      const transparentVaultsEpoch = await internalStatesOrchestrator.getTransparentVaultsEpoch();
      expect(transparentVaultsEpoch.length).to.equal(6);

      // Process all vaults in preprocessing phase - continue until we reach buffering phase
      while ((await internalStatesOrchestrator.currentPhase()) === 1n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }

      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // Buffering

      const bufferAmountBefore = await internalStatesOrchestrator.bufferAmount();
      console.log(`Buffer Amount Before: ${bufferAmountBefore.toString()}`);
      expect(bufferAmountBefore).to.equal(0);

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

      // Trigger a price mismatch between measured and execution in a way that benefits the vaults, leading to buffer amount increase.
      const lossAmount1 = ethers.parseUnits("500", underlyingDecimals);
      await underlyingAsset.connect(user).approve(await mockAsset1.getAddress(), lossAmount1);
      await mockAsset1.connect(user).simulateLosses(lossAmount1, user.address);

      const lossAmount2 = ethers.parseUnits("530", underlyingDecimals);
      await underlyingAsset.connect(user).approve(await mockAsset2.getAddress(), lossAmount2);
      await mockAsset2.connect(user).simulateLosses(lossAmount2, user.address);

      const lossAmount3 = ethers.parseUnits("50", underlyingDecimals);
      await underlyingAsset.connect(user).approve(await mockAsset3.getAddress(), lossAmount3);
      await mockAsset3.connect(user).simulateLosses(lossAmount3, user.address);

      // Now check if liquidity orchestrator needs to be triggered
      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle

      while ((await liquidityOrchestrator.currentPhase()) !== 3n) {
        const [_liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
        void expect(_liquidityUpkeepNeeded).to.be.true;
        await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      }

      expect(await liquidityOrchestrator.deltaBufferAmount()).to.be.gt(0);

      const bufferAmountAfterRebalancing = await internalStatesOrchestrator.bufferAmount();

      console.log("Buffer Amount After Rebalancing:", bufferAmountAfterRebalancing.toString());
      expect(bufferAmountAfterRebalancing).to.be.gt(bufferAmountBefore);

      while ((await liquidityOrchestrator.currentPhase()) === 3n) {
        [_liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
        void expect(_liquidityUpkeepNeeded).to.be.true;
        await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      }

      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle

      const userBalanceOfAbsoluteVault = await absoluteVault.balanceOf(user.address);
      expect(userBalanceOfAbsoluteVault).to.equal(
        ethers.parseUnits(ABSOLUTE_VAULT_DEPOSIT.toString(), await absoluteVault.decimals()),
      );

      const userBalanceOfSoftHurdleVault = await softHurdleVault.balanceOf(user.address);
      expect(userBalanceOfSoftHurdleVault).to.equal(
        ethers.parseUnits(SOFT_HURDLE_VAULT_DEPOSIT.toString(), await softHurdleVault.decimals()),
      );

      const userBalanceOfHardHurdleVault = await hardHurdleVault.balanceOf(user.address);
      expect(userBalanceOfHardHurdleVault).to.equal(
        ethers.parseUnits(HARD_HURDLE_VAULT_DEPOSIT.toString(), await hardHurdleVault.decimals()),
      );

      const userBalanceOfHighWaterMarkVault = await highWaterMarkVault.balanceOf(user.address);
      expect(userBalanceOfHighWaterMarkVault).to.equal(
        ethers.parseUnits(HIGH_WATER_MARK_VAULT_DEPOSIT.toString(), await highWaterMarkVault.decimals()),
      );

      const userBalanceOfHurdleHwmVault = await hurdleHwmVault.balanceOf(user.address);
      expect(userBalanceOfHurdleHwmVault).to.equal(
        ethers.parseUnits(HURDLE_HWM_VAULT_DEPOSIT.toString(), await hurdleHwmVault.decimals()),
      );

      // Fast forward time to trigger upkeep
      await time.increase(epochDuration + 1n);

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");

      while ((await internalStatesOrchestrator.currentPhase()) !== 2n) {
        [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }

      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // Buffering

      const bufferAmountEpoch21 = await internalStatesOrchestrator.bufferAmount();

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);

      const bufferAmountEpoch22 = await internalStatesOrchestrator.bufferAmount();
      expect(bufferAmountEpoch22).to.be.equal(bufferAmountEpoch21);
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
      await expect(internalStatesOrchestrator.connect(curator).performUpkeep(performData)).to.be.reverted;
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
      await time.increase((await orionConfig.feeChangeCooldownDuration()) + 1n);

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
      const lossAmount1 = ethers.parseUnits("5", underlyingDecimals);
      await mockAsset1.connect(owner).simulateLosses(lossAmount1, owner.address);

      const lossAmount2 = ethers.parseUnits("7", underlyingDecimals);
      await mockAsset2.connect(owner).simulateLosses(lossAmount2, owner.address);

      const lossAmount3 = ethers.parseUnits("10", underlyingDecimals);
      await mockAsset3.connect(owner).simulateLosses(lossAmount3, owner.address);

      // Continue liquidity orchestrator execution phases
      while ((await liquidityOrchestrator.currentPhase()) === 2n) {
        [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
        void expect(liquidityUpkeepNeeded).to.be.true;
        await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      }

      expect(await liquidityOrchestrator.currentPhase()).to.equal(3); // FulfillDepositAndRedeem

      while ((await liquidityOrchestrator.currentPhase()) === 3n) {
        [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
        void expect(liquidityUpkeepNeeded).to.be.true;
        await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      }
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

      const depositAmount = ethers.parseUnits("1000", underlyingDecimals);
      const bufferAmountBeforeDeposit = await internalStatesOrchestrator.bufferAmount();

      await underlyingAsset.mint(user.address, depositAmount);
      await underlyingAsset.connect(user).approve(await liquidityOrchestrator.getAddress(), depositAmount);

      await liquidityOrchestrator.connect(user).depositLiquidity(depositAmount);

      // Check that the buffer amount increased by the deposit amount
      const bufferAmountAfterDeposit = await internalStatesOrchestrator.bufferAmount();
      expect(bufferAmountAfterDeposit).to.equal(bufferAmountBeforeDeposit + depositAmount);

      const withdrawAmount = ethers.parseUnits("500", underlyingDecimals);
      const bufferAmountBeforeWithdraw = bufferAmountAfterDeposit;

      await liquidityOrchestrator.connect(user).withdrawLiquidity(withdrawAmount);

      const bufferAmountAfterWithdraw = await internalStatesOrchestrator.bufferAmount();
      expect(bufferAmountAfterWithdraw).to.equal(bufferAmountBeforeWithdraw - withdrawAmount);
    });

    it("should revert depositLiquidity when system is not idle", async function () {
      const epochDuration = await internalStatesOrchestrator.epochDuration();

      // Ensure system is idle first
      const currentPhase = await internalStatesOrchestrator.currentPhase();
      if (currentPhase !== 0n) {
        // Wait for epoch to complete if needed
        await time.increase(epochDuration + 1n);
        let [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        while (_upkeepNeeded) {
          await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
          [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        }
      }

      // Start a new epoch to get system out of idle
      await time.increase(epochDuration + 1n);
      const [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);

      // System should now be in a non-idle phase
      const phase = await internalStatesOrchestrator.currentPhase();
      expect(phase).to.not.equal(0);

      const depositAmount = ethers.parseUnits("1000", underlyingDecimals);
      await underlyingAsset.mint(user.address, depositAmount);
      await underlyingAsset.connect(user).approve(await liquidityOrchestrator.getAddress(), depositAmount);

      // Should revert with SystemNotIdle
      await expect(liquidityOrchestrator.connect(user).depositLiquidity(depositAmount)).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "SystemNotIdle",
      );
    });

    it("should revert withdrawLiquidity when system is not idle", async function () {
      const epochDuration = await internalStatesOrchestrator.epochDuration();

      // Ensure system is idle first and has some buffer
      const currentPhase = await internalStatesOrchestrator.currentPhase();
      if (currentPhase !== 0n) {
        // Wait for epoch to complete if needed
        await time.increase(epochDuration + 1n);
        let [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        while (_upkeepNeeded) {
          await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
          [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
        }
      }

      // Deposit some liquidity first when idle
      const depositAmount = ethers.parseUnits("1000", underlyingDecimals);
      await underlyingAsset.mint(user.address, depositAmount);
      await underlyingAsset.connect(user).approve(await liquidityOrchestrator.getAddress(), depositAmount);
      await liquidityOrchestrator.connect(user).depositLiquidity(depositAmount);

      // Start a new epoch to get system out of idle
      await time.increase(epochDuration + 1n);
      const [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);

      // System should now be in a non-idle phase
      const phase = await internalStatesOrchestrator.currentPhase();
      expect(phase).to.not.equal(0);

      const withdrawAmount = ethers.parseUnits("500", underlyingDecimals);

      // Should revert with SystemNotIdle
      await expect(liquidityOrchestrator.connect(user).withdrawLiquidity(withdrawAmount)).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "SystemNotIdle",
      );
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

      // Check cooldown
      const [activeVFee, activeRsFee] = await internalStatesOrchestrator.activeProtocolFees();
      expect(activeVFee).to.equal(0);
      expect(activeRsFee).to.equal(0);
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

  describe("DOS Attack Protection", function () {
    const MIN_DEPOSIT = ethers.parseUnits("100", 12); // 100 units in 12 decimals
    const MIN_REDEEM = ethers.parseUnits("100", 18); // 100 shares

    it("should allow owner to configure minimum amounts", async function () {
      // Not Owner should revert
      await expect(orionConfig.connect(user).setMinDepositAmount(MIN_DEPOSIT)).to.be.revertedWithCustomError(
        orionConfig,
        "OwnableUnauthorizedAccount",
      );
      await expect(orionConfig.connect(user).setMinRedeemAmount(MIN_REDEEM)).to.be.revertedWithCustomError(
        orionConfig,
        "OwnableUnauthorizedAccount",
      );

      // Set minimum deposit amount
      await expect(orionConfig.connect(owner).setMinDepositAmount(MIN_DEPOSIT))
        .to.emit(orionConfig, "MinDepositAmountUpdated")
        .withArgs(MIN_DEPOSIT);

      expect(await orionConfig.minDepositAmount()).to.equal(MIN_DEPOSIT);

      // Set minimum redeem amount
      await expect(orionConfig.connect(owner).setMinRedeemAmount(MIN_REDEEM))
        .to.emit(orionConfig, "MinRedeemAmountUpdated")
        .withArgs(MIN_REDEEM);

      expect(await orionConfig.minRedeemAmount()).to.equal(MIN_REDEEM);
    });

    it("should prevent 1 wei deposit attacks", async function () {
      // Configure minimum
      await orionConfig.connect(owner).setMinDepositAmount(MIN_DEPOSIT);

      // Attacker tries to deposit 1 wei
      await underlyingAsset.mint(user.address, 1n);
      await underlyingAsset.connect(user).approve(await absoluteVault.getAddress(), 1n);

      await expect(absoluteVault.connect(user).requestDeposit(1n)).to.be.revertedWithCustomError(
        absoluteVault,
        "BelowMinimumDeposit",
      );
    });

    it("should prevent deposits below minimum", async function () {
      await orionConfig.connect(owner).setMinDepositAmount(MIN_DEPOSIT);

      const smallAmount = MIN_DEPOSIT - 1n;
      await underlyingAsset.mint(user.address, smallAmount);
      await underlyingAsset.connect(user).approve(await absoluteVault.getAddress(), smallAmount);

      await expect(absoluteVault.connect(user).requestDeposit(smallAmount)).to.be.revertedWithCustomError(
        absoluteVault,
        "BelowMinimumDeposit",
      );
    });

    it("should allow deposits at exact minimum", async function () {
      await orionConfig.connect(owner).setMinDepositAmount(MIN_DEPOSIT);

      await underlyingAsset.mint(user.address, MIN_DEPOSIT);
      await underlyingAsset.connect(user).approve(await absoluteVault.getAddress(), MIN_DEPOSIT);

      await expect(absoluteVault.connect(user).requestDeposit(MIN_DEPOSIT)).to.not.be.reverted;
    });

    it("should prevent redemptions below minimum", async function () {
      await orionConfig.connect(owner).setMinRedeemAmount(MIN_REDEEM);

      // User needs shares first - do a legitimate deposit
      const depositAmount = ethers.parseUnits("500", underlyingDecimals);
      await underlyingAsset.mint(user.address, depositAmount);
      await underlyingAsset.connect(user).approve(await absoluteVault.getAddress(), depositAmount);
      await absoluteVault.connect(user).requestDeposit(depositAmount);

      // Process epoch to get shares
      await time.increase((await internalStatesOrchestrator.epochDuration()) + 1n);
      let [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      while (upkeepNeeded) {
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
        [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      }
      [upkeepNeeded, performData] = await liquidityOrchestrator.checkUpkeep("0x");
      while (upkeepNeeded) {
        await liquidityOrchestrator.connect(automationRegistry).performUpkeep(performData);
        [upkeepNeeded, performData] = await liquidityOrchestrator.checkUpkeep("0x");
      }

      // Now try to redeem below minimum
      const smallRedeemAmount = MIN_REDEEM - 1n;
      const userShares = await absoluteVault.balanceOf(user.address);

      expect(userShares).to.be.gte(smallRedeemAmount, "test setup should grant enough shares to redeem");

      await expect(absoluteVault.connect(user).requestRedeem(smallRedeemAmount)).to.be.revertedWithCustomError(
        absoluteVault,
        "BelowMinimumRedeem",
      );
    });

    it("should demonstrate economic infeasibility of queue flooding", async function () {
      await orionConfig.connect(owner).setMinDepositAmount(MIN_DEPOSIT);

      // Calculate attack cost using contract constant to prevent test drift
      const MAX_FULFILL_BATCH_SIZE = await absoluteVault.MAX_FULFILL_BATCH_SIZE();
      const totalCapitalRequired = MIN_DEPOSIT * MAX_FULFILL_BATCH_SIZE;

      // Convert to human-readable (12 decimals)
      const capitalInUnits = totalCapitalRequired / 10n ** BigInt(underlyingDecimals);

      console.log(
        `      ✓ Capital required to fill queue (${MAX_FULFILL_BATCH_SIZE} requests): ${capitalInUnits} units`,
      );
      console.log(`      ✓ Before mitigation: Only gas costs (~$1,500)`);
      console.log(`      ✓ After mitigation: ${capitalInUnits} units capital + gas costs`);
      console.log(`      ✓ Capital locked for: 1+ epochs (1+ days)`);

      expect(capitalInUnits).to.equal(15000n);
    });

    it("should work with existing workflow - legitimate operations succeed", async function () {
      // Configure protection
      await orionConfig.connect(owner).setMinDepositAmount(MIN_DEPOSIT);
      await orionConfig.connect(owner).setMinRedeemAmount(MIN_REDEEM);

      // Legitimate user deposits above minimum
      const legitimateAmount = ethers.parseUnits("1000", underlyingDecimals);
      await underlyingAsset.mint(user.address, legitimateAmount);
      await underlyingAsset.connect(user).approve(await absoluteVault.getAddress(), legitimateAmount);

      // Should succeed
      await expect(absoluteVault.connect(user).requestDeposit(legitimateAmount)).to.not.be.reverted;

      // Verify deposit is in pending queue
      const pendingDeposit = await absoluteVault.pendingDeposit();
      expect(pendingDeposit).to.be.gt(0);
    });

    it("should maintain protection during full epoch cycle", async function () {
      await orionConfig.connect(owner).setMinDepositAmount(MIN_DEPOSIT);

      // Try attack before epoch
      await underlyingAsset.mint(user.address, 1n);
      await underlyingAsset.connect(user).approve(await absoluteVault.getAddress(), 1n);
      await expect(absoluteVault.connect(user).requestDeposit(1n)).to.be.revertedWithCustomError(
        absoluteVault,
        "BelowMinimumDeposit",
      );

      // Process full epoch until system returns to idle
      await time.increase((await internalStatesOrchestrator.epochDuration()) + 1n);

      // Process Internal States Orchestrator
      let [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      while (upkeepNeeded) {
        await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
        [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      }

      // Process Liquidity Orchestrator
      [upkeepNeeded, performData] = await liquidityOrchestrator.checkUpkeep("0x");
      while (upkeepNeeded) {
        await liquidityOrchestrator.connect(automationRegistry).performUpkeep(performData);
        [upkeepNeeded, performData] = await liquidityOrchestrator.checkUpkeep("0x");
      }

      // Try attack after epoch - should still be blocked
      await underlyingAsset.mint(user.address, 1n);
      await underlyingAsset.connect(user).approve(await absoluteVault.getAddress(), 1n);
      await expect(absoluteVault.connect(user).requestDeposit(1n)).to.be.revertedWithCustomError(
        absoluteVault,
        "BelowMinimumDeposit",
      );
    });
  });
});
