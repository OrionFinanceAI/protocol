import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import "@openzeppelin/hardhat-upgrades";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";

import {
  MockUnderlyingAsset,
  MockERC4626Asset,
  OrionAssetERC4626ExecutionAdapter,
  OrionConfig,
  InternalStateOrchestrator,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  OrionTransparentVault,
  OrionAssetERC4626PriceAdapter,
} from "../typechain-types";

describe("Whitelist and Vault Removal Flows", function () {
  let transparentVaultFactory: TransparentVaultFactory;
  let orionConfig: OrionConfig;
  let underlyingAsset: MockUnderlyingAsset;
  let mockAsset1: MockERC4626Asset;
  let mockAsset2: MockERC4626Asset;
  let orionPriceAdapter: OrionAssetERC4626PriceAdapter;
  let orionExecutionAdapter: OrionAssetERC4626ExecutionAdapter;
  let InternalStateOrchestrator: InternalStateOrchestrator;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let testVault: OrionTransparentVault;

  let owner: SignerWithAddress;
  let strategist: SignerWithAddress;
  let automationRegistry: SignerWithAddress;
  let user: SignerWithAddress;

  beforeEach(async function () {
    [owner, strategist, automationRegistry, user] = await ethers.getSigners();

    // Deploy mock underlying asset first
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

    const initialDeposit1 = ethers.parseUnits("1000", 12);
    const initialDeposit2 = ethers.parseUnits("2000", 12);

    await underlyingAsset.mint(user.address, ethers.parseUnits("10000", 12));

    await underlyingAsset.connect(user).approve(await mockAsset1.getAddress(), initialDeposit1);
    await mockAsset1.connect(user).deposit(initialDeposit1, user.address);

    await underlyingAsset.connect(user).approve(await mockAsset2.getAddress(), initialDeposit2);
    await mockAsset2.connect(user).deposit(initialDeposit2, user.address);

    const deployed = await deployUpgradeableProtocol(owner, underlyingAsset, automationRegistry);

    orionConfig = deployed.orionConfig;
    InternalStateOrchestrator = deployed.InternalStateOrchestrator;
    liquidityOrchestrator = deployed.liquidityOrchestrator;
    transparentVaultFactory = deployed.transparentVaultFactory;

    // Deploy price adapter
    const OrionAssetERC4626PriceAdapterFactory = await ethers.getContractFactory("OrionAssetERC4626PriceAdapter");
    orionPriceAdapter = (await OrionAssetERC4626PriceAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as OrionAssetERC4626PriceAdapter;
    await orionPriceAdapter.waitForDeployment();

    // Configure protocol
    await InternalStateOrchestrator.connect(owner).updateProtocolFees(10, 1000);
    await liquidityOrchestrator.setTargetBufferRatio(100); // 1% target buffer ratio
    await liquidityOrchestrator.setSlippageTolerance(50); // 0.5% slippage

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

    const testVaultTx = await transparentVaultFactory
      .connect(owner)
      .createVault(strategist.address, "Test Vault", "TV", 0, 500, 50, ethers.ZeroAddress);
    const testVaultReceipt = await testVaultTx.wait();
    const testVaultEvent = testVaultReceipt?.logs.find((log) => {
      try {
        const parsed = transparentVaultFactory.interface.parseLog(log);
        return parsed?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const testVaultParsedEvent = transparentVaultFactory.interface.parseLog(testVaultEvent!);
    const testVaultAddress = testVaultParsedEvent?.args[0];
    testVault = (await ethers.getContractAt(
      "OrionTransparentVault",
      testVaultAddress,
    )) as unknown as OrionTransparentVault;

    // Then do the deposit
    await underlyingAsset.connect(user).approve(await testVault.getAddress(), ethers.parseUnits("100", 12));
    await testVault.connect(user).requestDeposit(ethers.parseUnits("100", 12));
  });

  it("should remove whitelisted asset and ensure liquidity orchestrator balance becomes zero", async function () {
    // Step 1: Give vault exposure to investment universe through intent submission
    const intent = [
      {
        token: await mockAsset1.getAddress(),
        weight: 400000000, // 40% allocation
      },
      {
        token: await mockAsset2.getAddress(),
        weight: 300000000, // 30% allocation
      },
      {
        token: await underlyingAsset.getAddress(),
        weight: 300000000, // 30% allocation
      },
    ];
    await testVault.connect(strategist).submitIntent(intent);

    // Step 2: Trigger orchestrators to process the intent and build orders
    const epochDuration = await InternalStateOrchestrator.epochDuration();
    await time.increase(epochDuration + 1n);

    // Process InternalStateOrchestrator phases
    let [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

    // Process all vaults in preprocessing phase
    while ((await InternalStateOrchestrator.currentPhase()) === 1n) {
      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    }
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(2); // Buffering

    [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

    // Process all vaults in postprocessing phase
    while ((await InternalStateOrchestrator.currentPhase()) === 3n) {
      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    }
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

    [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(0); // Back to Idle

    // Step 3: Trigger liquidity orchestrator to execute trades and get assets
    let [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
    if (liquidityUpkeepNeeded) {
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      // Process liquidity orchestrator phases
      while ((await liquidityOrchestrator.currentPhase()) !== 0n) {
        [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
        if (liquidityUpkeepNeeded) {
          await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
        }
      }
    }

    // Verify liquidity orchestrator has positive balance of whitelisted assets
    const mockAsset1BalanceBefore = await mockAsset1.balanceOf(await liquidityOrchestrator.getAddress());
    const mockAsset2BalanceBefore = await mockAsset2.balanceOf(await liquidityOrchestrator.getAddress());

    // At least one asset should have positive balance
    expect(mockAsset1BalanceBefore + mockAsset2BalanceBefore).to.be.gt(0);

    // Step 4: Remove mockAsset1 from whitelist BEFORE processing orchestrators
    await orionConfig.connect(owner).removeWhitelistedAsset(await mockAsset1.getAddress());

    // Verify the asset is no longer whitelisted
    await expect(await orionConfig.isWhitelisted(await mockAsset1.getAddress())).to.be.false;
    await expect(await orionConfig.isWhitelisted(await mockAsset2.getAddress())).to.be.true;

    // Step 5: Wait for new epoch and retrigger orchestrators to process the removal
    await time.increase(epochDuration + 1n);

    // Process InternalStateOrchestrator phases again
    [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

    // Process all vaults in preprocessing phase
    while ((await InternalStateOrchestrator.currentPhase()) === 1n) {
      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    }
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(2); // Buffering

    [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

    // Process all vaults in postprocessing phase
    while ((await InternalStateOrchestrator.currentPhase()) === 3n) {
      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    }
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

    [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(0); // Back to Idle

    // Step 5.5: Trigger liquidity orchestrator to execute trades
    let [liquidityUpkeepNeeded2, liquidityPerformData2] = await liquidityOrchestrator.checkUpkeep("0x");
    if (liquidityUpkeepNeeded2) {
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData2);

      // Process liquidity orchestrator phases
      while ((await liquidityOrchestrator.currentPhase()) !== 0n) {
        [liquidityUpkeepNeeded2, liquidityPerformData2] = await liquidityOrchestrator.checkUpkeep("0x");
        if (liquidityUpkeepNeeded2) {
          await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData2);
        }
      }
    }

    // Step 6: Assert liquidity orchestrator balance of blacklisted asset is zero
    const mockAsset1BalanceAfter = await mockAsset1.balanceOf(await liquidityOrchestrator.getAddress());

    // The blacklisted asset (mockAsset1) should have zero balance
    expect(mockAsset1BalanceAfter).to.equal(0);

    // Verify that the system is in a consistent state
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(0); // Idle
    expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle
  });

  it("should remove whitelisted asset when underlying asset is not in intent initially", async function () {
    // Step 1: Give vault exposure to investment universe through intent submission
    const intent = [
      {
        token: await mockAsset1.getAddress(),
        weight: 500000000, // 50% allocation
      },
      {
        token: await mockAsset2.getAddress(),
        weight: 500000000, // 50% allocation
      },
    ];
    await testVault.connect(strategist).submitIntent(intent);

    // Step 2: Trigger orchestrators to process the intent and build orders
    const epochDuration = await InternalStateOrchestrator.epochDuration();
    await time.increase(epochDuration + 1n);

    // Process InternalStateOrchestrator phases
    let [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

    // Process all vaults in preprocessing phase
    while ((await InternalStateOrchestrator.currentPhase()) === 1n) {
      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    }
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(2); // Buffering

    [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

    // Process all vaults in postprocessing phase
    while ((await InternalStateOrchestrator.currentPhase()) === 3n) {
      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    }
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

    [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(0); // Back to Idle

    // Step 3: Trigger liquidity orchestrator to execute trades and get assets
    let [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
    if (liquidityUpkeepNeeded) {
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      // Process liquidity orchestrator phases
      while ((await liquidityOrchestrator.currentPhase()) !== 0n) {
        [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
        if (liquidityUpkeepNeeded) {
          await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
        }
      }
    }

    // Verify liquidity orchestrator has positive balance of whitelisted assets
    const mockAsset1BalanceBefore = await mockAsset1.balanceOf(await liquidityOrchestrator.getAddress());
    const mockAsset2BalanceBefore = await mockAsset2.balanceOf(await liquidityOrchestrator.getAddress());

    // At least one asset should have positive balance
    expect(mockAsset1BalanceBefore + mockAsset2BalanceBefore).to.be.gt(0);

    // Step 4: Remove mockAsset1 from whitelist BEFORE processing orchestrators
    await orionConfig.connect(owner).removeWhitelistedAsset(await mockAsset1.getAddress());

    // Verify the asset is no longer whitelisted
    await expect(await orionConfig.isWhitelisted(await mockAsset1.getAddress())).to.be.false;
    await expect(await orionConfig.isWhitelisted(await mockAsset2.getAddress())).to.be.true;

    // Step 5: Wait for new epoch and retrigger orchestrators to process the removal
    await time.increase(epochDuration + 1n);

    // Process InternalStateOrchestrator phases again
    [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

    // Process all vaults in preprocessing phase
    while ((await InternalStateOrchestrator.currentPhase()) === 1n) {
      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    }
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(2); // Buffering

    [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

    // Process all vaults in postprocessing phase
    while ((await InternalStateOrchestrator.currentPhase()) === 3n) {
      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    }
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

    [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(0); // Back to Idle

    // Step 5.5: Trigger liquidity orchestrator to execute trades
    let [liquidityUpkeepNeeded2, liquidityPerformData2] = await liquidityOrchestrator.checkUpkeep("0x");
    if (liquidityUpkeepNeeded2) {
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData2);

      // Process liquidity orchestrator phases
      while ((await liquidityOrchestrator.currentPhase()) !== 0n) {
        [liquidityUpkeepNeeded2, liquidityPerformData2] = await liquidityOrchestrator.checkUpkeep("0x");
        if (liquidityUpkeepNeeded2) {
          await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData2);
        }
      }
    }

    // Step 6: Assert liquidity orchestrator balance of blacklisted asset is zero
    const mockAsset1BalanceAfter = await mockAsset1.balanceOf(await liquidityOrchestrator.getAddress());

    // The blacklisted asset (mockAsset1) should have zero balance
    expect(mockAsset1BalanceAfter).to.equal(0);

    // Verify that the system is in a consistent state
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(0); // Idle
    expect(await liquidityOrchestrator.currentPhase()).to.equal(0); // Idle
  });

  it("Should allow synchronous redemption after vault decommissioning", async function () {
    // Step 1: Give vault exposure to investment universe through intent submission
    const intent = [
      {
        token: await mockAsset1.getAddress(),
        weight: 400000000, // 40% allocation
      },
      {
        token: await mockAsset2.getAddress(),
        weight: 300000000, // 30% allocation
      },
      {
        token: await underlyingAsset.getAddress(),
        weight: 300000000, // 30% allocation
      },
    ];
    await testVault.connect(strategist).submitIntent(intent);

    // Step 2: Trigger orchestrators to process the intent and build orders
    const epochDuration = await InternalStateOrchestrator.epochDuration();
    await time.increase(epochDuration + 1n);

    // Process InternalStateOrchestrator phases
    let [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

    // Process all vaults in preprocessing phase
    while ((await InternalStateOrchestrator.currentPhase()) === 1n) {
      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    }
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(2); // Buffering

    [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

    // Process all vaults in postprocessing phase
    while ((await InternalStateOrchestrator.currentPhase()) === 3n) {
      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    }
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

    [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(0); // Back to Idle

    // Step 3: Trigger liquidity orchestrator to execute trades and get assets
    let [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
    if (liquidityUpkeepNeeded) {
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      // Process liquidity orchestrator phases
      while ((await liquidityOrchestrator.currentPhase()) !== 0n) {
        [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
        if (liquidityUpkeepNeeded) {
          await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
        }
      }
    }

    const userShares = await testVault.balanceOf(user.address);
    expect(userShares).to.be.gt(0);

    const vaultTotalAssets = await testVault.totalAssets();
    expect(vaultTotalAssets).to.be.gt(0);

    void expect(await orionConfig.isSystemIdle()).to.be.true;

    await orionConfig.connect(owner).removeOrionVault(await testVault.getAddress());

    void expect(await testVault.isDecommissioning()).to.be.true;
    void expect(await orionConfig.isDecommissionedVault(await testVault.getAddress())).to.be.false;
    void expect(await orionConfig.isOrionVault(await testVault.getAddress())).to.be.true;

    await expect(testVault.connect(user).redeem(1n, user.address, user.address)).to.be.revertedWithCustomError(
      testVault,
      "SynchronousCallDisabled",
    );

    await time.increase(epochDuration + 1n);

    // Step 4: Trigger orchestrators again so that liquidity orchestrator completes vault decommissioning
    // First, trigger internal state orchestrator to process the decommissioning vault
    [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

    // Process all vaults in preprocessing phase (including decommissioning vault)
    while ((await InternalStateOrchestrator.currentPhase()) === 1n) {
      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    }
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(2); // Buffering

    [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

    // Process all vaults in postprocessing phase (including decommissioning vault)
    while ((await InternalStateOrchestrator.currentPhase()) === 3n) {
      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    }
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

    [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
    expect(await InternalStateOrchestrator.currentPhase()).to.equal(0); // Back to Idle

    // Now trigger liquidity orchestrator to complete vault decommissioning
    [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
    if (liquidityUpkeepNeeded) {
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);

      // Process liquidity orchestrator phases until idle
      while ((await liquidityOrchestrator.currentPhase()) !== 0n) {
        [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
        if (liquidityUpkeepNeeded) {
          await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
        }
      }
    }

    // Verify that vault decommissioning is now complete
    void expect(await orionConfig.isDecommissionedVault(await testVault.getAddress())).to.be.true;
    void expect(await orionConfig.isDecommissioningVault(await testVault.getAddress())).to.be.false;
    void expect(await orionConfig.isOrionVault(await testVault.getAddress())).to.be.false;

    // Test synchronous redemption
    const redeemShares = userShares / 2n; // Redeem half of the shares
    const expectedAssets = await testVault.convertToAssets(redeemShares);

    // Get initial balances
    const initialUserUnderlyingBalance = await underlyingAsset.balanceOf(user.address);
    const initialVaultTotalAssets = await testVault.totalAssets();

    // Calculate share price before redeem
    const shareDecimals = await testVault.decimals();
    const oneShare = 10n ** BigInt(shareDecimals);
    const sharePriceBefore = await testVault.convertToAssets(oneShare);

    await testVault.connect(user).redeem(redeemShares, user.address, user.address);

    // Verify redemption results
    const finalUserUnderlyingBalance = await underlyingAsset.balanceOf(user.address);
    const finalVaultTotalAssets = await testVault.totalAssets();
    const finalUserShares = await testVault.balanceOf(user.address);

    // Check that user received underlying assets
    expect(finalUserUnderlyingBalance).to.equal(initialUserUnderlyingBalance + expectedAssets);

    // Check that vault total assets decreased
    expect(finalVaultTotalAssets).to.equal(initialVaultTotalAssets - expectedAssets);

    // Check that user shares decreased
    expect(finalUserShares).to.equal(userShares - redeemShares);

    // Verify share price invariant is preserved after redeem
    const sharePriceAfter = await testVault.convertToAssets(oneShare);
    expect(sharePriceAfter).to.equal(sharePriceBefore, "Share price should remain unchanged after redeem");

    const pendingVaultFees = await testVault.pendingVaultFees();
    if (pendingVaultFees > 0) {
      const initialOwnerBalance = await underlyingAsset.balanceOf(owner.address);

      // Claim vault fees (this should work also for decommissioned vaults)
      await testVault.connect(owner).claimVaultFees(pendingVaultFees);

      const finalOwnerBalance = await underlyingAsset.balanceOf(owner.address);
      expect(finalOwnerBalance).to.equal(initialOwnerBalance + pendingVaultFees);
    }
  });

  it("should block requestDeposit when vault is decommissioning", async function () {
    await testVault.connect(strategist).submitIntent([{ token: await mockAsset1.getAddress(), weight: 1000000000 }]);
    // Mark vault for decommissioning
    await orionConfig.connect(owner).removeOrionVault(await testVault.getAddress());

    // Verify vault is decommissioning
    void expect(await testVault.isDecommissioning()).to.be.true;

    const epochDuration = await InternalStateOrchestrator.epochDuration();
    await time.increase(epochDuration + 1n);

    // Process one full epoch cycle to have some assets
    let [upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    while (upkeepNeeded) {
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
      [upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    }

    [upkeepNeeded, performData] = await liquidityOrchestrator.checkUpkeep("0x");
    while (upkeepNeeded) {
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(performData);
      [upkeepNeeded, performData] = await liquidityOrchestrator.checkUpkeep("0x");
    }

    // Try to request deposit - should revert
    const depositAmount = ethers.parseUnits("100", 12);
    await underlyingAsset.connect(user).approve(await testVault.getAddress(), depositAmount);

    await expect(testVault.connect(user).requestDeposit(depositAmount)).to.be.revertedWithCustomError(
      testVault,
      "VaultDecommissioned",
    );
  });

  it("should allow requestRedeem when vault is decommissioning", async function () {
    // First make a deposit and get some shares
    const depositAmount = ethers.parseUnits("1000", 12);
    await underlyingAsset.connect(user).approve(await testVault.getAddress(), depositAmount);
    await testVault.connect(user).requestDeposit(depositAmount);

    await testVault.connect(strategist).submitIntent([{ token: await mockAsset1.getAddress(), weight: 1000000000 }]);

    const epochDuration = await InternalStateOrchestrator.epochDuration();
    await time.increase(epochDuration + 1n);

    // Process epochs to fulfill the deposit
    let [upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    while (upkeepNeeded || (await InternalStateOrchestrator.currentPhase()) !== 0n) {
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
      [upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
    }

    let [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
    while (liquidityUpkeepNeeded || (await liquidityOrchestrator.currentPhase()) !== 0n) {
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(liquidityPerformData);
      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
    }

    // Verify user has shares
    const userShares = await testVault.balanceOf(user.address);
    expect(userShares).to.be.gt(0);

    // Mark vault for decommissioning
    await orionConfig.connect(owner).removeOrionVault(await testVault.getAddress());

    void expect(await testVault.isDecommissioning()).to.be.true;

    await testVault.connect(user).approve(await testVault.getAddress(), userShares);
    await expect(testVault.connect(user).requestRedeem(userShares / 2n)).to.not.be.reverted;
  });
});
