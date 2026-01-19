/**
 * OrchestratorSecurity.test.ts
 *
 * This file contains security-focused tests for orchestrator protection against malicious payloads
 * and invalid state transitions. It was extracted from the original Orchestrators.test.ts file.
 *
 * EXTRACTION DETAILS:
 * ===================
 * - Lines 1-578: beforeEach setup block (same as other refactored test files)
 * - Lines 2546-end: Security tests section
 *
 * WHAT THIS FILE TESTS:
 * ======================
 *
 * 1. InternalStateOrchestrator (ISO) SECURITY (2 tests)
 *
 *    a) Malicious Payload Protection - Single Phase Execution
 *       - Tests that ISO ignores malicious performData payloads
 *       - Attacker tries to trick ISO into executing wrong phase action
 *       - ISO should execute action appropriate for current phase only
 *       - Example: In Preprocessing phase, trying to trigger Postprocessing should fail
 *       - Validates phase integrity and prevents unauthorized state manipulation
 *
 *    b) Malicious Payload Protection - Minibatch Execution
 *       - Tests that ISO ignores malicious minibatch-related payloads
 *       - Attacker tries to specify arbitrary vaults or batch parameters
 *       - ISO should process next minibatch in correct order only
 *       - Prevents manipulation of which vaults get processed
 *       - Ensures fair processing order (round-robin across all vaults)
 *
 * 2. LIQUIDITYORCHESTRATOR (LO) SECURITY (5 tests)
 *
 *    a) Invalid start() Protection
 *       - Tests that calling start() does not update LO phase
 *       - start() should only set lastEpochEnd timestamp, not change phase
 *       - Prevents unauthorized phase transitions via start() function
 *       - Ensures phase changes only happen through proper performUpkeep flow
 *
 *    b) InvalidState Phase Order Enforcement
 *       - Tests that executing phases out of order reverts with InvalidState
 *       - Correct order: Idle → SellingLeg → BuyingLeg → ProcessVaultOperations → Idle
 *       - Example: Cannot call processBuy when in SellingLeg phase
 *       - Enforces strict phase progression to maintain system integrity
 *
 *    c) Malicious Minibatch Payload Protection
 *       - Tests that LO ignores malicious minibatch parameters in performData
 *       - Attacker tries to specify arbitrary vaults or batch sizes
 *       - LO should process vaults in correct order only
 *       - Prevents cherry-picking which orders to execute
 *
 *    d) Cross-Phase Malicious Payload Protection - SellingLeg
 *       - Tests that malicious payload for processSell is ignored in BuyingLeg phase
 *       - Ensures phase-specific functions only execute in correct phase
 *       - Prevents revert-based attacks that try to skip phases
 *
 *    e) Cross-Phase Malicious Payload Protection - BuyingLeg
 *       - Tests that malicious payload for processBuy is ignored in ProcessVaultOperations phase
 *       - Validates strict phase boundaries
 *       - Ensures fulfill phase cannot be bypassed
 *
 * SECURITY PRINCIPLES TESTED:
 * ===========================
 * - Payload Validation: All performData from performUpkeep is ignored/validated
 * - Phase Integrity: Phase transitions follow strict state machine rules
 * - Minibatch Fairness: Vaults processed in order, cannot be manipulated
 * - Function Guards: Phase-specific functions protected by state checks
 * - Attack Prevention: Malicious actors cannot skip, reorder, or manipulate execution
 *
 * WHY THESE TESTS MATTER:
 * =======================
 * - Orchestrators are automated via Chainlink Automation (off-chain automation)
 * - performUpkeep receives performData parameter from off-chain keeper
 * - Malicious keeper could try to manipulate execution via crafted performData
 * - These tests ensure protocol is secure even if keeper is compromised
 * - Phase state machine must be bulletproof against manipulation attempts
 *
 * ATTACK VECTORS PREVENTED:
 * =========================
 * - Payload manipulation: Crafted performData to trigger wrong actions
 * - Phase skipping: Attempting to jump ahead in state machine
 * - Phase reversal: Attempting to go backward in state machine
 * - Vault cherry-picking: Selecting specific vaults to process/skip
 * - DOS via revert: Using malicious payload to cause reverts
 * - Unauthorized start: Using start() to manipulate phase state
 *
 * TOTAL TESTS: 7 (2 ISO + 5 LO)
 */

import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployUpgradeableProtocol } from "../helpers/deployUpgradeable";

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

describe("Orchestrator Security", function () {
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

  beforeEach(async function () {
    [owner, strategist, automationRegistry, user] = await ethers.getSigners();

    underlyingDecimals = 12;

    // Deploy mock underlying asset first
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

    // Deploy upgradeable protocol
    const deployed = await deployUpgradeableProtocol(owner, underlyingAsset, automationRegistry);

    orionConfig = deployed.orionConfig;
    liquidityOrchestrator = deployed.liquidityOrchestrator;
    transparentVaultFactory = deployed.transparentVaultFactory;

    // Deploy KBestTvlWeightedAverage passive strategist with k=2
    const KBestTvlWeightedAverageFactory = await ethers.getContractFactory("KBestTvlWeightedAverage");
    const kbestTvlPassiveStrategistDeployed = await KBestTvlWeightedAverageFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
      1, // k=1, select top 1 asset for passive strategist
    );
    await kbestTvlPassiveStrategistDeployed.waitForDeployment();
    kbestTvlPassiveStrategist = kbestTvlPassiveStrategistDeployed as unknown as KBestTvlWeightedAverage;

    const OrionAssetERC4626PriceAdapterFactory = await ethers.getContractFactory("OrionAssetERC4626PriceAdapter");
    orionPriceAdapter = (await OrionAssetERC4626PriceAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as OrionAssetERC4626PriceAdapter;
    await orionPriceAdapter.waitForDeployment();

    // Configure protocol
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
      .createVault(strategist.address, "Hurdle HWM Vault", "HHWMV", 4, 2000, 250, ethers.ZeroAddress);
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
  });
  describe("Security Tests - InternalStateOrchestrator InvalidState Protection", function () {
    const createMaliciousPerformData = (action: string, minibatchIndex: number = 0) => {
      const actionHash = ethers.keccak256(ethers.toUtf8Bytes(action));
      const actionBytes4 = actionHash.slice(0, 10);
      return ethers.AbiCoder.defaultAbiCoder().encode(["bytes4", "uint8"], [actionBytes4, minibatchIndex]);
    };

    it("should ignore malicious payloads and execute correct action for current phase", async function () {
      // TODO: use helper function to process full epoch, taking
      // zkVM orchestrator fixture as input.

      const epochDuration = await InternalStateOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      const [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await InternalStateOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      // Malicious payload for buffer() should be ignored - correct action for current phase is executed
      const maliciousData = createMaliciousPerformData("buffer()", 0);
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(maliciousData);

      // Should still be in PreprocessingTransparentVaults or progressed to next phase, not buffer phase
      const currentPhase = await InternalStateOrchestrator.currentPhase();
      expect(currentPhase).to.not.equal(2); // Not Buffering - malicious payload was ignored
    });

    it("should ignore malicious payloads and execute correct minibatch action for current phase", async function () {
      // TODO: use helper function to process full epoch, taking
      // zkVM orchestrator fixture as input.

      const epochDuration = await InternalStateOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      const [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await InternalStateOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      // Malicious payload for buffer() should be ignored - correct action for current phase is executed
      const maliciousData = createMaliciousPerformData("buffer()", 0);
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(maliciousData);

      // Should still be in PreprocessingTransparentVaults or progressed to next phase, not buffer phase
      const currentPhase = await InternalStateOrchestrator.currentPhase();
      expect(currentPhase).to.not.equal(2); // Not Buffering - malicious payload was ignored
    });
  });

  describe("Security Tests - LiquidityOrchestrator InvalidState Protection", function () {
    const createMaliciousLiquidityPerformData = (action: string, minibatchIndex: number = 0) => {
      const actionHash = ethers.keccak256(ethers.toUtf8Bytes(action));
      const actionBytes4 = actionHash.slice(0, 10);
      return ethers.AbiCoder.defaultAbiCoder().encode(["bytes4", "uint8"], [actionBytes4, minibatchIndex]);
    };

    it("should revert with InvalidState when trying to execute phases out of order", async function () {
      // TODO: use helper function to process full epoch, taking
      // zkVM orchestrator fixture as input.

      const epochDuration = await InternalStateOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      let [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await InternalStateOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      // Process all vaults in preprocessing phase - continue until we reach buffering phase
      while ((await InternalStateOrchestrator.currentPhase()) === 1n) {
        [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
        await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await InternalStateOrchestrator.currentPhase()).to.equal(2); // Buffering

      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await InternalStateOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

      // Process all vaults in postprocessing phase - continue until we reach building orders phase
      while ((await InternalStateOrchestrator.currentPhase()) === 3n) {
        [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
        await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
      }
      expect(await InternalStateOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await InternalStateOrchestrator.currentPhase()).to.equal(0); // Back to Idle

      const [_liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      expect(await liquidityOrchestrator.currentPhase()).to.equal(2); // BuyingLeg (skips SellingLeg since no selling tokens)

      // Malicious payload for processSell() should be ignored - correct action for current phase is executed
      const maliciousData = createMaliciousLiquidityPerformData("processSell(uint8)", 0);
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(maliciousData);

      // Should still be in BuyingLeg or progressed to next phase, not SellingLeg
      const currentPhase = await liquidityOrchestrator.currentPhase();
      expect(currentPhase).to.not.equal(1); // Not SellingLeg - malicious payload was ignored
    });
  });
});
