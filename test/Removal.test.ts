import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import "@openzeppelin/hardhat-upgrades";
import { ethers, network } from "hardhat";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { processFullEpoch } from "./helpers/orchestratorHelpers";
import { resetNetwork } from "./helpers/resetNetwork";

import {
  MockUnderlyingAsset,
  MockERC4626Asset,
  ERC4626ExecutionAdapter,
  OrionConfig,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  OrionTransparentVault,
  ERC4626PriceAdapter,
} from "../typechain-types";

describe("Whitelist and Vault Removal Flows", function () {
  let transparentVaultFactory: TransparentVaultFactory;
  let orionConfig: OrionConfig;
  let underlyingAsset: MockUnderlyingAsset;
  let mockAsset1: MockERC4626Asset;
  let mockAsset2: MockERC4626Asset;
  let orionPriceAdapter: ERC4626PriceAdapter;
  let orionExecutionAdapter: ERC4626ExecutionAdapter;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let testVault: OrionTransparentVault;

  let owner: SignerWithAddress;
  let strategist: SignerWithAddress;
  let automationRegistry: SignerWithAddress;
  let user: SignerWithAddress;

  let removalSetupSnapshotId: string;

  before(async function () {
    await resetNetwork();

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
    liquidityOrchestrator = deployed.liquidityOrchestrator;
    transparentVaultFactory = deployed.transparentVaultFactory;

    console.log("orionConfig address", await orionConfig.getAddress());

    // Deploy MockPriceAdapter - these vaults use USDC as underlying (same-asset), ERC4626PriceAdapter rejects same-asset
    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    orionPriceAdapter = (await MockPriceAdapterFactory.deploy()) as unknown as ERC4626PriceAdapter;
    await orionPriceAdapter.waitForDeployment();

    // Configure protocol
    await orionConfig.connect(owner).updateProtocolFees(10, 1000);
    await liquidityOrchestrator.setTargetBufferRatio(100); // 1% target buffer ratio
    await liquidityOrchestrator.setSlippageTolerance(50); // 0.5% slippage

    const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
    orionExecutionAdapter = (await ERC4626ExecutionAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as ERC4626ExecutionAdapter;
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

    removalSetupSnapshotId = (await network.provider.send("evm_snapshot", [])) as string;
  });

  beforeEach(async function () {
    await network.provider.send("evm_revert", [removalSetupSnapshotId]);
    removalSetupSnapshotId = (await network.provider.send("evm_snapshot", [])) as string;
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

    // Step 2: Process full epoch via LiquidityOrchestrator (zkVM fixture: Removal1)
    await processFullEpoch(liquidityOrchestrator, automationRegistry, "Removal1");

    // Verify liquidity orchestrator has positive balance of whitelisted assets
    const mockAsset1BalanceBefore = await mockAsset1.balanceOf(await liquidityOrchestrator.getAddress());
    const mockAsset2BalanceBefore = await mockAsset2.balanceOf(await liquidityOrchestrator.getAddress());

    // At least one asset should have positive balance
    expect(mockAsset1BalanceBefore + mockAsset2BalanceBefore).to.be.gt(0);

    // Step 4: Remove mockAsset1 from whitelist BEFORE processing orchestrators (enters decommissioning)
    await orionConfig.connect(owner).removeWhitelistedAsset(await mockAsset1.getAddress());

    // Verify the asset is still whitelisted but in decommissioning (removed only after completeAssetsRemoval)
    void expect(await orionConfig.isWhitelisted(await mockAsset1.getAddress())).to.be.true;
    const decommissioning = await orionConfig.decommissioningAssets();
    expect(decommissioning).to.include(await mockAsset1.getAddress());
    void expect(await orionConfig.isWhitelisted(await mockAsset2.getAddress())).to.be.true;

    // Step 5: Process full epoch to drain removed asset (zkVM fixture: Removal2)
    await processFullEpoch(liquidityOrchestrator, automationRegistry, "Removal2");

    // Step 6: Assert liquidity orchestrator balance of removed asset is zero
    const mockAsset1BalanceAfter = await mockAsset1.balanceOf(await liquidityOrchestrator.getAddress());

    // The removed asset (mockAsset1) should have zero balance
    expect(mockAsset1BalanceAfter).to.equal(0);

    // Each vault's portfolio must not include the removed asset after drain and completeAssetsRemoval
    const removedAssetAddress = await mockAsset1.getAddress();
    const transparentVaults = await orionConfig.getAllOrionVaults(0); // VaultType.Transparent
    for (const vaultAddress of transparentVaults) {
      const vault = (await ethers.getContractAt(
        "OrionTransparentVault",
        vaultAddress,
      )) as unknown as OrionTransparentVault;
      const [portfolioTokens] = await vault.getPortfolio();
      void expect(
        portfolioTokens.includes(removedAssetAddress),
        `Vault ${vaultAddress} portfolio should not include removed asset ${removedAssetAddress}`,
      ).to.be.false;
    }

    // Verify that the system is in a consistent state
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

    // Step 2: Process full epoch
    await processFullEpoch(liquidityOrchestrator, automationRegistry, "Removal3");

    // Verify liquidity orchestrator has positive balance of whitelisted assets
    const mockAsset1BalanceBefore = await mockAsset1.balanceOf(await liquidityOrchestrator.getAddress());
    const mockAsset2BalanceBefore = await mockAsset2.balanceOf(await liquidityOrchestrator.getAddress());

    // At least one asset should have positive balance
    expect(mockAsset1BalanceBefore + mockAsset2BalanceBefore).to.be.gt(0);

    // Step 4: Remove mockAsset1 from whitelist BEFORE processing orchestrators (enters decommissioning)
    await orionConfig.connect(owner).removeWhitelistedAsset(await mockAsset1.getAddress());

    // Verify the asset is still whitelisted but in decommissioning (removed only after completeAssetsRemoval)
    void expect(await orionConfig.isWhitelisted(await mockAsset1.getAddress())).to.be.true;
    const decommissioning2 = await orionConfig.decommissioningAssets();
    expect(decommissioning2).to.include(await mockAsset1.getAddress());
    void expect(await orionConfig.isWhitelisted(await mockAsset2.getAddress())).to.be.true;

    // Step 5: Process full epoch to drain removed asset
    await processFullEpoch(liquidityOrchestrator, automationRegistry, "Removal4");

    // Step 6: Assert liquidity orchestrator balance of removed asset is zero
    const mockAsset1BalanceAfter = await mockAsset1.balanceOf(await liquidityOrchestrator.getAddress());

    // The removed asset (mockAsset1) should have zero balance
    expect(mockAsset1BalanceAfter).to.equal(0);

    // Verify that the system is in a consistent state
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

    // Step 2: Process full epoch
    await processFullEpoch(liquidityOrchestrator, automationRegistry, "Removal5");

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

    // Step 4: Process full epoch so LiquidityOrchestrator completes vault decommissioning
    await processFullEpoch(liquidityOrchestrator, automationRegistry, "Removal6");

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

  it("should revert with ERC4626ExceededMaxRedeem when redeem shares exceed owner balance (after decommissioning)", async function () {
    const intent = [
      { token: await mockAsset1.getAddress(), weight: 400000000 },
      { token: await mockAsset2.getAddress(), weight: 300000000 },
      { token: await underlyingAsset.getAddress(), weight: 300000000 },
    ];

    let decommissionedVaults = await orionConfig.getAllDecommissionedVaults();
    expect(decommissionedVaults).to.not.include(await testVault.getAddress());

    await testVault.connect(strategist).submitIntent(intent);
    await processFullEpoch(liquidityOrchestrator, automationRegistry, "Removal5");

    await orionConfig.connect(owner).removeOrionVault(await testVault.getAddress());
    decommissionedVaults = await orionConfig.getAllDecommissionedVaults();
    expect(decommissionedVaults).to.not.include(await testVault.getAddress());

    await processFullEpoch(liquidityOrchestrator, automationRegistry, "Removal6");
    decommissionedVaults = await orionConfig.getAllDecommissionedVaults();
    expect(decommissionedVaults).to.include(await testVault.getAddress());

    void expect(await orionConfig.isDecommissionedVault(await testVault.getAddress())).to.be.true;

    const userBalance = await testVault.balanceOf(user.address);
    expect(userBalance).to.be.gt(0);

    const sharesExceedingBalance = userBalance + 1n;
    await expect(
      testVault.connect(user).redeem(sharesExceedingBalance, user.address, user.address),
    ).to.be.revertedWithCustomError(testVault, "ERC4626ExceededMaxRedeem");
  });

  it("should revert when redeem owner is not msg.sender and has no allowance (after decommissioning)", async function () {
    const intent = [
      { token: await mockAsset1.getAddress(), weight: 400000000 },
      { token: await mockAsset2.getAddress(), weight: 300000000 },
      { token: await underlyingAsset.getAddress(), weight: 300000000 },
    ];

    let decommissionedVaults = await orionConfig.getAllDecommissionedVaults();
    expect(decommissionedVaults).to.not.include(await testVault.getAddress());

    await testVault.connect(strategist).submitIntent(intent);
    await processFullEpoch(liquidityOrchestrator, automationRegistry, "Removal5");

    await orionConfig.connect(owner).removeOrionVault(await testVault.getAddress());
    decommissionedVaults = await orionConfig.getAllDecommissionedVaults();
    expect(decommissionedVaults).to.not.include(await testVault.getAddress());

    await processFullEpoch(liquidityOrchestrator, automationRegistry, "Removal6");
    decommissionedVaults = await orionConfig.getAllDecommissionedVaults();
    expect(decommissionedVaults).to.include(await testVault.getAddress());

    void expect(await orionConfig.isDecommissionedVault(await testVault.getAddress())).to.be.true;

    const userBalance = await testVault.balanceOf(user.address);
    expect(userBalance).to.be.gt(0);
    const redeemShares = userBalance / 2n;

    await expect(
      testVault.connect(strategist).redeem(redeemShares, user.address, user.address),
    ).to.be.revertedWithCustomError(testVault, "ERC20InsufficientAllowance");
  });

  it("should block requestDeposit when vault is decommissioning", async function () {
    let decommissionedVaults = await orionConfig.getAllDecommissionedVaults();
    expect(decommissionedVaults).to.not.include(await testVault.getAddress());

    await testVault.connect(strategist).submitIntent([{ token: await mockAsset1.getAddress(), weight: 1000000000 }]);
    // Mark vault for decommissioning
    await orionConfig.connect(owner).removeOrionVault(await testVault.getAddress());

    decommissionedVaults = await orionConfig.getAllDecommissionedVaults();
    expect(decommissionedVaults).to.not.include(await testVault.getAddress());

    // Verify vault is decommissioning
    void expect(await testVault.isDecommissioning()).to.be.true;

    // Process one full epoch cycle
    await processFullEpoch(liquidityOrchestrator, automationRegistry, "Removal7");

    decommissionedVaults = await orionConfig.getAllDecommissionedVaults();
    expect(decommissionedVaults).to.include(await testVault.getAddress());

    // Try to request deposit - should revert
    const depositAmount = ethers.parseUnits("100", 12);
    await underlyingAsset.connect(user).approve(await testVault.getAddress(), depositAmount);

    await expect(testVault.connect(user).requestDeposit(depositAmount)).to.be.revertedWithCustomError(
      testVault,
      "VaultDecommissioned",
    );
  });

  it("should allow requestRedeem when vault is decommissioning", async function () {
    let decommissionedVaults = await orionConfig.getAllDecommissionedVaults();
    expect(decommissionedVaults).to.not.include(await testVault.getAddress());

    // First make a deposit and get some shares
    const depositAmount = ethers.parseUnits("1000", 12);
    await underlyingAsset.connect(user).approve(await testVault.getAddress(), depositAmount);
    await testVault.connect(user).requestDeposit(depositAmount);

    await testVault.connect(strategist).submitIntent([{ token: await mockAsset1.getAddress(), weight: 1000000000 }]);

    // Process full epoch to fulfill the deposit
    await processFullEpoch(liquidityOrchestrator, automationRegistry, "Removal8");

    // Verify user has shares
    const userShares = await testVault.balanceOf(user.address);
    expect(userShares).to.be.gt(0);

    // Mark vault for decommissioning
    await orionConfig.connect(owner).removeOrionVault(await testVault.getAddress());

    decommissionedVaults = await orionConfig.getAllDecommissionedVaults();
    expect(decommissionedVaults).to.not.include(await testVault.getAddress());

    void expect(await testVault.isDecommissioning()).to.be.true;

    await testVault.connect(user).approve(await testVault.getAddress(), userShares);
    await expect(testVault.connect(user).requestRedeem(userShares / 2n)).to.not.be.reverted;
  });
});
