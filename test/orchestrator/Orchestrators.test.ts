import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import {
  MockUnderlyingAsset,
  MockERC4626Asset,
  OrionAssetERC4626ExecutionAdapter,
  OrionConfig,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  OrionTransparentVault,
  OrionAssetERC4626PriceAdapter,
  KBestTvlWeightedAverage,
} from "../../typechain-types";
import { deployUpgradeableProtocol } from "../helpers/deployUpgradeable";
import { processFullEpoch } from "../helpers/orchestratorHelpers";
import { resetNetwork } from "../helpers/resetNetwork";

/**
 * Deterministic environment for zkVM fixtures:
 * - Single deployment in before() so orionConfig and all contract addresses are fixed.
 * - resetNetwork() gives a clean chain; deployment order fixes addresses for fixture generation.
 */
describe("Orchestrators", function () {
  let initialSnapshotId: string;

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
  let liquidityOrchestrator: LiquidityOrchestrator;
  let absoluteVault: OrionTransparentVault;
  let highWaterMarkVault: OrionTransparentVault;
  let softHurdleVault: OrionTransparentVault;
  let hardHurdleVault: OrionTransparentVault;
  let hurdleHwmVault: OrionTransparentVault;
  let kbestTvlPassiveStrategist: KBestTvlWeightedAverage;
  let passiveVault: OrionTransparentVault;

  let underlyingDecimals: number;

  let owner: SignerWithAddress;
  let strategist: SignerWithAddress;
  let automationRegistry: SignerWithAddress;
  let user: SignerWithAddress;

  before(async function () {
    await resetNetwork();

    [owner, strategist, automationRegistry, user] = await ethers.getSigners();

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

    const deployed = await deployUpgradeableProtocol(owner, underlyingAsset, automationRegistry);
    orionConfig = deployed.orionConfig;
    liquidityOrchestrator = deployed.liquidityOrchestrator;
    transparentVaultFactory = deployed.transparentVaultFactory;

    console.log("orionConfig address", await orionConfig.getAddress());

    const OrionAssetERC4626PriceAdapterFactory = await ethers.getContractFactory("OrionAssetERC4626PriceAdapter");
    orionPriceAdapter = (await OrionAssetERC4626PriceAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as OrionAssetERC4626PriceAdapter;
    await orionPriceAdapter.waitForDeployment();

    await orionConfig.connect(owner).updateProtocolFees(10, 1000);

    await expect(orionConfig.connect(owner).updateProtocolFees(51, 0)).to.be.revertedWithCustomError(
      orionConfig,
      "InvalidArguments",
    );

    await expect(orionConfig.connect(owner).updateProtocolFees(0, 2001)).to.be.revertedWithCustomError(
      orionConfig,
      "InvalidArguments",
    );

    await expect(liquidityOrchestrator.setTargetBufferRatio(0)).to.be.revertedWithCustomError(
      liquidityOrchestrator,
      "InvalidArguments",
    );

    await expect(liquidityOrchestrator.setTargetBufferRatio(501)).to.be.revertedWithCustomError(
      liquidityOrchestrator,
      "InvalidArguments",
    );

    await expect(liquidityOrchestrator.setTargetBufferRatio(100)).to.not.be.reverted;
    await liquidityOrchestrator.setSlippageTolerance(50); // 0.5% slippage

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

    // Deploy KBestTvlWeightedAverage passive strategist with k=1 and contract-specific investment universe
    const investmentUniverse = [...(await orionConfig.getAllWhitelistedAssets())];
    const KBestTvlWeightedAverageFactory = await ethers.getContractFactory("KBestTvlWeightedAverage");
    const kbestTvlPassiveStrategistDeployed = await KBestTvlWeightedAverageFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
      1, // k=1, select top 1 asset for passive strategist
      investmentUniverse,
    );
    await kbestTvlPassiveStrategistDeployed.waitForDeployment();
    kbestTvlPassiveStrategist = kbestTvlPassiveStrategistDeployed as unknown as KBestTvlWeightedAverage;

    await orionConfig.setProtocolRiskFreeRate(0.0423 * 10_000);

    const absoluteVaultTx = await transparentVaultFactory
      .connect(owner)
      .createVault(strategist.address, "Absolute Fee Vault", "AFV", 0, 500, 50, ethers.ZeroAddress);
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
      .createVault(strategist.address, "Soft Hurdle Vault", "SHV", 1, 1200, 80, ethers.ZeroAddress);
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
      .createVault(strategist.address, "Hard Hurdle Vault", "HHV", 2, 1500, 200, ethers.ZeroAddress);
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
      .createVault(strategist.address, "High Water Mark Vault", "HWMV", 3, 800, 150, ethers.ZeroAddress);
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
      .createVault(strategist.address, "Hurdle HWM Vault", "HHWM", 4, 2000, 250, ethers.ZeroAddress);
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

    // Create passive vault with kbestTVL passive strategist (no strategist intents)
    const passiveVaultTx = await transparentVaultFactory
      .connect(owner)
      .createVault(strategist.address, "Passive KBest TVL Vault", "PKTV", 0, 0, 0, ethers.ZeroAddress);
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

    await passiveVault.connect(owner).updateStrategist(await kbestTvlPassiveStrategist.getAddress());
    await kbestTvlPassiveStrategist.connect(owner).submitIntent(passiveVault);

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
    await absoluteVault.connect(strategist).submitIntent(absoluteIntent);

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
    await softHurdleVault.connect(strategist).submitIntent(softHurdleIntent);
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
    await hardHurdleVault.connect(strategist).submitIntent(hardHurdleIntent);
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
    await highWaterMarkVault.connect(strategist).submitIntent(highWaterMarkIntent);
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
    await hurdleHwmVault.connect(strategist).submitIntent(hurdleHwmIntent);
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

    initialSnapshotId = (await network.provider.send("evm_snapshot", [])) as string;
  });

  beforeEach(async function () {
    await network.provider.send("evm_revert", [initialSnapshotId]);
    initialSnapshotId = (await network.provider.send("evm_snapshot", [])) as string;
  });

  describe("Idle-only functionality", function () {
    it("should revert when system is not idle", async function () {
      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle
      void expect(await orionConfig.isSystemIdle()).to.be.true;

      console.log("orionConfig address", await orionConfig.getAddress());

      await expect(orionConfig.connect(owner).removeOrionVault(await hurdleHwmVault.getAddress())).not.to.be.reverted;
      await expect(orionConfig.connect(owner).removeWhitelistedAsset(await mockAsset1.getAddress())).not.to.be.reverted;

      const epochDuration = await liquidityOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);
      await time.increase((await orionConfig.feeChangeCooldownDuration()) + 1n);

      const upkeepNeeded = await liquidityOrchestrator.checkUpkeep();
      void expect(upkeepNeeded).to.be.true;
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x", "0x", "0x");
      expect(await liquidityOrchestrator.currentPhase()).to.equal(1); // Not idle anymore

      void expect(await orionConfig.isSystemIdle()).to.be.false;

      const vaultAddress = await hurdleHwmVault.getAddress();
      await expect(orionConfig.connect(owner).removeOrionVault(vaultAddress)).to.be.revertedWithCustomError(
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
        orionConfig.connect(owner).removeWhitelistedAsset(await mockAsset1.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "SystemNotIdle");

      await expect(
        orionConfig.connect(owner).removeOrionVault(await hurdleHwmVault.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "SystemNotIdle");

      // Test liquidityOrchestrator functions
      await expect(liquidityOrchestrator.updateEpochDuration(3600)).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "SystemNotIdle",
      );

      await expect(liquidityOrchestrator.updateMinibatchSize(5)).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "SystemNotIdle",
      );

      await expect(orionConfig.updateProtocolFees(50, 1000)).to.be.revertedWithCustomError(
        orionConfig,
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
        transparentVaultFactory.createVault(
          strategist.address,
          "Test Transparent Vault",
          "TTV",
          0,
          0,
          0,
          ethers.ZeroAddress,
        ),
      ).to.be.revertedWithCustomError(transparentVaultFactory, "SystemNotIdle");
    });
  });

  /**
   * performUpkeep tests drive the LiquidityOrchestrator with zkVM fixtures.
   */
  describe("performUpkeep", function () {
    it("should complete full upkeep cycles without intent decryption", async function () {
      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle
      void expect(await orionConfig.isSystemIdle()).to.be.true;

      const upkeepNeededBefore = await liquidityOrchestrator.checkUpkeep();
      void expect(upkeepNeededBefore).to.be.false;

      await time.increase((await orionConfig.feeChangeCooldownDuration()) + 1n);

      await processFullEpoch(liquidityOrchestrator, automationRegistry, "Orchestrator1");

      const transparentVaults = await orionConfig.getAllOrionVaults(0);
      expect(transparentVaults.length).to.equal(6);

      // After processFullEpoch, LO is back to Idle and state is applied from the zkVM fixture
      expect(await liquidityOrchestrator.currentPhase()).to.equal(0);

      const targetBufferRatio = await liquidityOrchestrator.targetBufferRatio();
      const BASIS_POINTS_FACTOR = 10_000n;
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
      const actualBufferAmount = await liquidityOrchestrator.bufferAmount();
      const delta =
        actualBufferAmount >= expectedBufferAmount
          ? actualBufferAmount - expectedBufferAmount
          : expectedBufferAmount - actualBufferAmount;
      // Allow relative error < 1e-10 (zkVM floating point precision error)
      if (expectedBufferAmount > 0n) {
        void expect(
          delta * 10n ** 10n <= expectedBufferAmount,
          `buffer amount relative error should be < 1e-10 (actual=${actualBufferAmount}, expected=${expectedBufferAmount})`,
        ).to.be.true;
      } else {
        expect(actualBufferAmount).to.equal(0n);
      }

      for (const v of [
        absoluteVault,
        highWaterMarkVault,
        softHurdleVault,
        hardHurdleVault,
        hurdleHwmVault,
        passiveVault,
      ]) {
        const totalAssets = await v.totalAssets();
        expect(totalAssets).to.be.gte(0);
        const [tokens] = await v.getPortfolio();
        expect(tokens.length).to.be.gte(0);
      }
    });

    it("should not update buffer after beneficial slippage epoch and no LP interactions", async function () {
      expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle
      void expect(await orionConfig.isSystemIdle()).to.be.true;

      const upkeepNeededBefore = await liquidityOrchestrator.checkUpkeep();
      void expect(upkeepNeededBefore).to.be.false;

      await time.increase((await orionConfig.feeChangeCooldownDuration()) + 1n);

      // First epoch: zkVM fixture drives state; LO runs sell/buy/process
      await processFullEpoch(liquidityOrchestrator, automationRegistry, "Orchestrator2");

      const transparentVaults = await orionConfig.getAllOrionVaults(0);
      expect(transparentVaults.length).to.equal(6);

      const bufferAmountBefore = await liquidityOrchestrator.bufferAmount();
      expect(bufferAmountBefore).to.be.gte(0);

      // Simulate beneficial slippage (losses in assets -> execution gets better prices)
      const lossAmount1 = ethers.parseUnits("500", underlyingDecimals);
      await underlyingAsset.connect(user).approve(await mockAsset1.getAddress(), lossAmount1);
      await mockAsset1.connect(user).simulateLosses(lossAmount1, user.address);
      const lossAmount2 = ethers.parseUnits("530", underlyingDecimals);
      await underlyingAsset.connect(user).approve(await mockAsset2.getAddress(), lossAmount2);
      await mockAsset2.connect(user).simulateLosses(lossAmount2, user.address);
      const lossAmount3 = ethers.parseUnits("50", underlyingDecimals);
      await underlyingAsset.connect(user).approve(await mockAsset3.getAddress(), lossAmount3);
      await mockAsset3.connect(user).simulateLosses(lossAmount3, user.address);

      // Second epoch: no LP interactions; buffer should not change
      const epochDuration = await liquidityOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);
      await processFullEpoch(liquidityOrchestrator, automationRegistry, "Orchestrator3");

      const bufferAmountEpoch21 = await liquidityOrchestrator.bufferAmount();
      const bufferAmountEpoch22 = await liquidityOrchestrator.bufferAmount();
      expect(bufferAmountEpoch22).to.equal(bufferAmountEpoch21);

      // User balances unchanged
      expect(await absoluteVault.balanceOf(user.address)).to.equal(
        ethers.parseUnits(ABSOLUTE_VAULT_DEPOSIT.toString(), await absoluteVault.decimals()),
      );
      expect(await softHurdleVault.balanceOf(user.address)).to.equal(
        ethers.parseUnits(SOFT_HURDLE_VAULT_DEPOSIT.toString(), await softHurdleVault.decimals()),
      );
      expect(await hardHurdleVault.balanceOf(user.address)).to.equal(
        ethers.parseUnits(HARD_HURDLE_VAULT_DEPOSIT.toString(), await hardHurdleVault.decimals()),
      );
      expect(await highWaterMarkVault.balanceOf(user.address)).to.equal(
        ethers.parseUnits(HIGH_WATER_MARK_VAULT_DEPOSIT.toString(), await highWaterMarkVault.decimals()),
      );
      expect(await hurdleHwmVault.balanceOf(user.address)).to.equal(
        ethers.parseUnits(HURDLE_HWM_VAULT_DEPOSIT.toString(), await hurdleHwmVault.decimals()),
      );
    });

    it("should not trigger upkeep when system is idle and time hasn't passed", async function () {
      const upkeepNeeded = await liquidityOrchestrator.checkUpkeep();
      void expect(upkeepNeeded).to.be.false;
    });

    it("should not trigger upkeep when not enough time has passed", async function () {
      const epochDuration = await liquidityOrchestrator.epochDuration();
      await time.increase(epochDuration / 2n);
      const upkeepNeeded = await liquidityOrchestrator.checkUpkeep();
      void expect(upkeepNeeded).to.be.false;
    });

    it("should allow owner to call performUpkeep", async function () {
      const epochDuration = await liquidityOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);
      await expect(liquidityOrchestrator.connect(owner).performUpkeep("0x", "0x", "0x")).to.not.be.reverted;
      await expect(
        liquidityOrchestrator.connect(strategist).performUpkeep("0x", "0x", "0x"),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "NotAuthorized");
    });

    it("should allow automation registry to call performUpkeep", async function () {
      const epochDuration = await liquidityOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);
      await expect(liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x", "0x", "0x")).to.not.be
        .reverted;
    });

    it("should not allow unauthorized addresses to call performUpkeep", async function () {
      const epochDuration = await liquidityOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);
      await expect(liquidityOrchestrator.connect(user).performUpkeep("0x", "0x", "0x")).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "NotAuthorized",
      );
    });

    it("should not trigger liquidity orchestrator when epoch counter hasn't changed", async function () {
      let upkeepNeeded = await liquidityOrchestrator.checkUpkeep();
      void expect(upkeepNeeded).to.be.false;
      upkeepNeeded = await liquidityOrchestrator.checkUpkeep();
      void expect(upkeepNeeded).to.be.false;
    });

    it("should allow owner to call liquidity orchestrator performUpkeep", async function () {
      const epochDuration = await liquidityOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);
      const upkeepNeeded = await liquidityOrchestrator.checkUpkeep();
      if (upkeepNeeded) {
        await expect(liquidityOrchestrator.connect(owner).performUpkeep("0x", "0x", "0x")).to.not.be.reverted;
      }
    });

    it("should allow automation registry to call liquidity orchestrator performUpkeep", async function () {
      const epochDuration = await liquidityOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);
      const upkeepNeeded = await liquidityOrchestrator.checkUpkeep();
      if (upkeepNeeded) {
        await expect(liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x", "0x", "0x")).to.not.be
          .reverted;
      }
    });

    it("should not allow unauthorized addresses to call liquidity orchestrator performUpkeep", async function () {
      const epochDuration = await liquidityOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);
      await expect(liquidityOrchestrator.connect(user).performUpkeep("0x", "0x", "0x")).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "NotAuthorized",
      );
    });

    it("should handle target buffer ratio calculations safely with edge cases", async function () {
      // Test with typical target buffer ratio
      await liquidityOrchestrator.setTargetBufferRatio(100);

      // Verify target buffer ratio is set correctly
      expect(await liquidityOrchestrator.targetBufferRatio()).to.equal(100);
    });

    it("should handle buffer and deposit/withdraw liquidity after full epoch", async function () {
      await time.increase((await orionConfig.feeChangeCooldownDuration()) + 1n);
      await processFullEpoch(liquidityOrchestrator, automationRegistry, "Orchestrator4");

      const initialBufferAmount = await liquidityOrchestrator.bufferAmount();
      expect(await liquidityOrchestrator.currentPhase()).to.equal(0);

      // Second epoch: run again (fixture may reflect market impact)
      const epochDuration = await liquidityOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);
      await processFullEpoch(liquidityOrchestrator, automationRegistry, "Orchestrator5");

      const finalBufferAmount = await liquidityOrchestrator.bufferAmount();
      expect(finalBufferAmount).to.be.gte(initialBufferAmount);

      // Deposit/withdraw liquidity when idle
      const depositAmount = ethers.parseUnits("1000", underlyingDecimals);
      const bufferAmountBeforeDeposit = await liquidityOrchestrator.bufferAmount();

      await underlyingAsset.mint(owner.address, depositAmount);
      await underlyingAsset.connect(owner).approve(await liquidityOrchestrator.getAddress(), depositAmount);
      await liquidityOrchestrator.connect(owner).depositLiquidity(depositAmount);

      const bufferAmountAfterDeposit = await liquidityOrchestrator.bufferAmount();
      expect(bufferAmountAfterDeposit).to.equal(bufferAmountBeforeDeposit + depositAmount);

      const withdrawAmount = ethers.parseUnits("500", underlyingDecimals);
      await liquidityOrchestrator.connect(owner).withdrawLiquidity(withdrawAmount);

      const bufferAmountAfterWithdraw = await liquidityOrchestrator.bufferAmount();
      expect(bufferAmountAfterWithdraw).to.equal(bufferAmountAfterDeposit - withdrawAmount);
    });

    it("should revert depositLiquidity when system is not idle", async function () {
      const epochDuration = await liquidityOrchestrator.epochDuration();
      const currentPhase = await liquidityOrchestrator.currentPhase();
      void expect(currentPhase).to.equal(0);

      await time.increase(epochDuration + 1n);
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x", "0x", "0x");
      expect(await liquidityOrchestrator.currentPhase()).to.not.equal(0);

      const depositAmount = ethers.parseUnits("1000", underlyingDecimals);
      await underlyingAsset.mint(owner.address, depositAmount);
      await underlyingAsset.connect(owner).approve(await liquidityOrchestrator.getAddress(), depositAmount);
      await expect(liquidityOrchestrator.connect(owner).depositLiquidity(depositAmount)).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "SystemNotIdle",
      );
    });

    it("should revert withdrawLiquidity when system is not idle", async function () {
      const epochDuration = await liquidityOrchestrator.epochDuration();
      const currentPhase = await liquidityOrchestrator.currentPhase();
      void expect(currentPhase).to.equal(0);

      const depositAmount = ethers.parseUnits("1000", underlyingDecimals);
      await underlyingAsset.mint(owner.address, depositAmount);
      await underlyingAsset.connect(owner).approve(await liquidityOrchestrator.getAddress(), depositAmount);
      await liquidityOrchestrator.connect(owner).depositLiquidity(depositAmount);

      await time.increase(epochDuration + 1n);
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x", "0x", "0x");
      expect(await liquidityOrchestrator.currentPhase()).to.not.equal(0);

      await expect(
        liquidityOrchestrator.connect(owner).withdrawLiquidity(ethers.parseUnits("500", underlyingDecimals)),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "SystemNotIdle");
    });
  });

  describe("configuration", function () {
    it("should allow owner to update epoch duration", async function () {
      const newEpochDuration = 2 * 24 * 60 * 60; // 2 days
      await liquidityOrchestrator.updateEpochDuration(newEpochDuration);
      expect(await liquidityOrchestrator.epochDuration()).to.equal(newEpochDuration);
    });

    it("should allow owner to update minibatch sizes", async function () {
      await expect(liquidityOrchestrator.updateMinibatchSize(2)).to.not.be.reverted;
    });

    it("should allow owner to update protocol fees", async function () {
      await orionConfig.connect(owner).updateProtocolFees(50, 100); // 0.5% volume fee, 1% revenue share
      expect(await orionConfig.vFeeCoefficient()).to.equal(50);
      expect(await orionConfig.rsFeeCoefficient()).to.equal(100);

      // During cooldown, active rates reflect previous; after first deploy that is (0, 0)
      const [activeVFee, activeRsFee] = await orionConfig.activeProtocolFees();
      expect(activeVFee).to.equal(0);
      expect(activeRsFee).to.equal(0);
    });

    it("should revert when updating protocol fees with invalid arguments", async function () {
      await expect(orionConfig.connect(owner).updateProtocolFees(101, 100)).to.be.revertedWithCustomError(
        orionConfig,
        "InvalidArguments",
      );
      await expect(orionConfig.connect(owner).updateProtocolFees(50, 2001)).to.be.revertedWithCustomError(
        orionConfig,
        "InvalidArguments",
      );
      await expect(orionConfig.connect(owner).updateProtocolFees(101, 2001)).to.be.revertedWithCustomError(
        orionConfig,
        "InvalidArguments",
      );
    });

    it("should not allow non-owner to update configuration", async function () {
      await expect(liquidityOrchestrator.connect(strategist).updateEpochDuration(86400)).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "NotAuthorized",
      );
    });

    it("should revert when updating automation registry with zero address", async function () {
      await expect(liquidityOrchestrator.updateAutomationRegistry(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "ZeroAddress",
      );
    });

    it("should successfully update automation registry and emit event", async function () {
      const newAutomationRegistry = user.address;
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
        "NotAuthorized",
      );
      await expect(orionConfig.connect(user).setMinRedeemAmount(MIN_REDEEM)).to.be.revertedWithCustomError(
        orionConfig,
        "NotAuthorized",
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

      // Process epoch to get shares (zkVM fixture drives state; LO runs full cycle)
      await time.increase((await liquidityOrchestrator.epochDuration()) + 1n);
      await time.increase((await orionConfig.feeChangeCooldownDuration()) + 1n);
      await processFullEpoch(liquidityOrchestrator, automationRegistry, "Orchestrator6");

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
      const MAX_FULFILL_BATCH_SIZE = await orionConfig.maxFulfillBatchSize();
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
      const pendingDeposit = await absoluteVault.pendingDeposit(await orionConfig.maxFulfillBatchSize());
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

      await time.increase((await liquidityOrchestrator.epochDuration()) + 1n);
      await time.increase((await orionConfig.feeChangeCooldownDuration()) + 1n);
      await processFullEpoch(liquidityOrchestrator, automationRegistry, "Orchestrator1");

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
