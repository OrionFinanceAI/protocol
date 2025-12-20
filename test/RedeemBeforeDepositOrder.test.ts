/**
 * @title Redeem Before Deposit Order Test
 * @notice Verifies that LiquidityOrchestrator processes redemptions before deposits
 * @dev Tests the fix in commit 31f6378 that ensures correct share pricing
 *
 * CONTEXT:
 * The order of operations during vault fulfillment is critical for fair share pricing.
 * If deposits are processed before redemptions, new shares are minted against an
 * inflated total asset value, which dilutes redeemers unfairly.
 *
 * CORRECT ORDER (implemented):
 * 1. Process redemptions first (burn shares, pay out assets)
 * 2. Process deposits second (mint shares against reduced total assets)
 *
 * This ensures:
 * - Redeemers get fair price based on pre-deposit vault state
 * - Depositors get shares based on post-redeem vault state
 * - No dilution attacks possible
 */

import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";

import {
  MockUnderlyingAsset,
  MockERC4626Asset,
  MockPriceAdapter,
  MockExecutionAdapter,
  OrionConfig,
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  OrionTransparentVault,
} from "../typechain-types";

describe("Redeem Before Deposit Order Verification", function () {
  let underlyingAsset: MockUnderlyingAsset;
  let mockAsset: MockERC4626Asset;
  let mockPriceAdapter: MockPriceAdapter;
  let mockExecutionAdapter: MockExecutionAdapter;
  let orionConfig: OrionConfig;
  let internalStatesOrchestrator: InternalStatesOrchestrator;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let transparentVaultFactory: TransparentVaultFactory;
  let vault: OrionTransparentVault;

  let owner: SignerWithAddress;
  let curator: SignerWithAddress;
  let initialDepositor: SignerWithAddress;
  let redeemer: SignerWithAddress;
  let newDepositor: SignerWithAddress;
  let automationRegistry: SignerWithAddress;

  const UNDERLYING_DECIMALS = 6;
  const INITIAL_ASSETS = ethers.parseUnits("100", UNDERLYING_DECIMALS);
  const REDEEM_AMOUNT_SHARES = ethers.parseUnits("90", 18); // 90 shares (90% of vault)
  const NEW_DEPOSIT_AMOUNT = ethers.parseUnits("10", UNDERLYING_DECIMALS); // 10 USDC

  let epochDuration: bigint;

  async function processInternalStatesOrchestrator(): Promise<void> {
    let [upkeepNeeded] = await internalStatesOrchestrator.checkUpkeep("0x");
    while (upkeepNeeded) {
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep("0x");
      [upkeepNeeded] = await internalStatesOrchestrator.checkUpkeep("0x");
    }
  }

  async function processLiquidityOrchestrator(): Promise<void> {
    let [upkeepNeeded] = await liquidityOrchestrator.checkUpkeep("0x");
    while (upkeepNeeded) {
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x");
      [upkeepNeeded] = await liquidityOrchestrator.checkUpkeep("0x");
    }
  }

  async function processFullEpoch(): Promise<void> {
    await time.increase(epochDuration + 1n);
    await processInternalStatesOrchestrator();
    await processLiquidityOrchestrator();
  }

  async function captureVaultState() {
    return {
      totalAssets: await vault.totalAssets(),
      totalSupply: await vault.totalSupply(),
      pendingDeposit: await vault.pendingDeposit(await orionConfig.maxFulfillBatchSize()),
      pendingRedeem: await vault.pendingRedeem(await orionConfig.maxFulfillBatchSize()),
    };
  }

  beforeEach(async function () {
    [owner, curator, initialDepositor, redeemer, newDepositor, automationRegistry] = await ethers.getSigners();

    // Deploy underlying asset (USDC with 6 decimals)
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    underlyingAsset = (await MockUnderlyingAssetFactory.deploy(UNDERLYING_DECIMALS)) as unknown as MockUnderlyingAsset;

    // Deploy mock ERC4626 asset
    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    mockAsset = (await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Mock Vault",
      "mVault",
    )) as unknown as MockERC4626Asset;

    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    mockPriceAdapter = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;

    const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
    mockExecutionAdapter = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;

    const deployed = await deployUpgradeableProtocol(owner, owner, underlyingAsset, automationRegistry);

    orionConfig = deployed.orionConfig;
    internalStatesOrchestrator = deployed.internalStatesOrchestrator;
    liquidityOrchestrator = deployed.liquidityOrchestrator;
    transparentVaultFactory = deployed.transparentVaultFactory;

    // Configure protocol
    await orionConfig.setProtocolRiskFreeRate(0);
    await liquidityOrchestrator.connect(owner).setTargetBufferRatio(100); // 1% buffer
    await liquidityOrchestrator.connect(owner).updateMinibatchSize(8); // Process all vaults in one batch

    // Whitelist the mock asset
    await orionConfig.addWhitelistedAsset(
      await mockAsset.getAddress(),
      await mockPriceAdapter.getAddress(),
      await mockExecutionAdapter.getAddress(),
    );

    // Create vault
    const tx = await transparentVaultFactory.createVault(
      curator.address,
      "Test Vault",
      "TVault",
      0,
      0,
      0,
      ethers.ZeroAddress,
    );
    const receipt = await tx.wait();
    const event = receipt?.logs.find((log) => {
      try {
        const parsed = transparentVaultFactory.interface.parseLog(log);
        return parsed?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const parsedEvent = transparentVaultFactory.interface.parseLog(event!);
    const vaultAddress = parsedEvent?.args[0];
    vault = (await ethers.getContractAt("OrionTransparentVault", vaultAddress)) as unknown as OrionTransparentVault;

    // Submit curator intent (100% to underlying asset to avoid liquidity orchestrator complexity)
    await vault.connect(curator).submitIntent([
      {
        token: await underlyingAsset.getAddress(),
        weight: 1000000000, // 100% in basis points (10^9)
      },
    ]);

    epochDuration = await internalStatesOrchestrator.epochDuration();

    // Setup initial state: Deposit 100 USDC and fulfill to establish baseline
    await underlyingAsset.mint(initialDepositor.address, INITIAL_ASSETS);
    await underlyingAsset.connect(initialDepositor).approve(await vault.getAddress(), INITIAL_ASSETS);
    await vault.connect(initialDepositor).requestDeposit(INITIAL_ASSETS);

    await processFullEpoch();

    const initialState = await captureVaultState();
    // Note: 1% buffer was allocated, so totalAssets = 99 USDC (100 - 1)
    const expectedAssetsAfterBuffer = ethers.parseUnits("99", UNDERLYING_DECIMALS);
    expect(initialState.totalAssets).to.equal(expectedAssetsAfterBuffer);
    expect(initialState.totalSupply).to.equal(ethers.parseUnits("100", 18)); // 100 shares with 18 decimals

    const balanceOfVault = await vault.balanceOf(initialDepositor.address);
    const assets = await vault.convertToAssets(balanceOfVault);
    expect(assets).to.equal(expectedAssetsAfterBuffer);
  });

  describe("Fulfillment Order Verification", function () {
    it("Should process redemptions before deposits for correct share pricing", async function () {
      // Transfer shares from initialDepositor to redeemer for redemption test
      await vault.connect(initialDepositor).transfer(redeemer.address, REDEEM_AMOUNT_SHARES);

      // Phase A: Verify setup state
      const expectedAssetsAfterBuffer = ethers.parseUnits("99", UNDERLYING_DECIMALS); // 99 USDC (after 1% buffer)
      expect(await vault.totalAssets()).to.equal(expectedAssetsAfterBuffer);
      expect(await vault.totalSupply()).to.equal(ethers.parseUnits("100", 18));
      expect(await vault.balanceOf(redeemer.address)).to.equal(REDEEM_AMOUNT_SHARES);

      // Phase B: Create conflicting requests
      // Redeemer requests 90 shares redemption
      await vault.connect(redeemer).approve(await vault.getAddress(), REDEEM_AMOUNT_SHARES);
      await vault.connect(redeemer).requestRedeem(REDEEM_AMOUNT_SHARES);

      // New depositor requests 10 USDC deposit
      await underlyingAsset.mint(newDepositor.address, NEW_DEPOSIT_AMOUNT);
      await underlyingAsset.connect(newDepositor).approve(await vault.getAddress(), NEW_DEPOSIT_AMOUNT);
      await vault.connect(newDepositor).requestDeposit(NEW_DEPOSIT_AMOUNT);

      // Verify pending state
      expect(await vault.pendingRedeem(await orionConfig.maxFulfillBatchSize())).to.equal(REDEEM_AMOUNT_SHARES);
      expect(await vault.pendingDeposit(await orionConfig.maxFulfillBatchSize())).to.equal(NEW_DEPOSIT_AMOUNT);

      // Phase C: Process through orchestrator phases
      await time.increase(epochDuration + 1n);
      await processInternalStatesOrchestrator();

      // Phase D: Verify totalAssets calculations reflect correct order
      const vaultAddress = await vault.getAddress();
      const [totalAssetsForRedeem, totalAssetsForDeposit] =
        await internalStatesOrchestrator.getVaultTotalAssetsAll(vaultAddress);

      // CRITICAL ASSERTION: Redeem uses higher totalAssets (before deposit impact)
      expect(totalAssetsForRedeem).to.be.gt(totalAssetsForDeposit);
      expect(totalAssetsForRedeem).to.equal(ethers.parseUnits("99", UNDERLYING_DECIMALS));
      expect(totalAssetsForDeposit).to.equal(ethers.parseUnits("9.9", UNDERLYING_DECIMALS));

      // Capture state before fulfillment
      const balanceBeforeRedeem = await underlyingAsset.balanceOf(redeemer.address);

      // Phase E: Process fulfillment
      await processLiquidityOrchestrator();

      // Phase F: Verify correct execution order and results
      const finalState = await captureVaultState();

      // Verify redemption was processed (redeemer received assets)
      const balanceAfterRedeem = await underlyingAsset.balanceOf(redeemer.address);
      const assetsReceived = balanceAfterRedeem - balanceBeforeRedeem;
      console.log(`Redeemer received: ${ethers.formatUnits(assetsReceived, UNDERLYING_DECIMALS)} USDC`);

      // Redeemer should receive exactly 89.1 USDC (90 shares * 99 totalAssets / 100 totalSupply)
      const expectedRedeemed = ethers.parseUnits("89.1", UNDERLYING_DECIMALS);
      expect(assetsReceived).to.equal(expectedRedeemed);

      // Verify deposit was processed (newDepositor received shares)
      const newDepositorShares = await vault.balanceOf(newDepositor.address);
      console.log(`New depositor received: ${ethers.formatUnits(newDepositorShares, 18)} shares`);

      // Calculate exact expected shares for new depositor using PIT totalAssets
      // After redeem: totalAssets = 99 - 89.1 = 9.9 USDC, totalSupply = 100 - 90 = 10 shares
      // Formula: shares = assets * (totalSupply + 10^decimalsOffset) / (totalAssets + 1)
      // With decimalsOffset = 18 - 6 = 12, this is: 10 * (10 + 10^12) / (9.9 + 1)
      // Due to Solidity's integer division rounding, we need to use the inflation-resistant calculation
      const decimalsOffset = 12n;
      const totalSupplyAfterRedeem = ethers.parseUnits("10", 18);
      const virtualSupply = totalSupplyAfterRedeem + 10n ** decimalsOffset;
      const virtualAssets = totalAssetsForDeposit + 1n;
      const expectedNewDepositorShares = (NEW_DEPOSIT_AMOUNT * virtualSupply) / virtualAssets;
      expect(newDepositorShares).to.equal(expectedNewDepositorShares);

      // Verify final vault state with exact equality
      // Total assets = 9.9 + 10 = 19.9 USDC exactly
      const expectedFinalAssets = ethers.parseUnits("19.9", UNDERLYING_DECIMALS);
      expect(finalState.totalAssets).to.equal(expectedFinalAssets);

      // Total supply = 10 + expectedNewDepositorShares exactly
      const expectedFinalSupply = totalSupplyAfterRedeem + expectedNewDepositorShares;
      expect(finalState.totalSupply).to.equal(expectedFinalSupply);

      // Verify pending amounts cleared
      expect(finalState.pendingRedeem).to.equal(0);
      expect(finalState.pendingDeposit).to.equal(0);

      console.log(`Final total assets: ${ethers.formatUnits(finalState.totalAssets, UNDERLYING_DECIMALS)} USDC`);
      console.log(`Final total supply: ${ethers.formatUnits(finalState.totalSupply, 18)} shares`);
    });

    it("Should maintain fair pricing for both redeemers and depositors", async function () {
      // Transfer shares for redemption
      await vault.connect(initialDepositor).transfer(redeemer.address, REDEEM_AMOUNT_SHARES);

      // Calculate expected share price at request time (should be 1:1)
      const totalAssetsBefore = await vault.totalAssets();
      const totalSupplyBefore = await vault.totalSupply();
      const sharePrice = (totalAssetsBefore * ethers.parseUnits("1", 18)) / totalSupplyBefore;
      console.log(`Initial share price: ${ethers.formatUnits(sharePrice, UNDERLYING_DECIMALS)} USDC per share`);

      // Make requests
      await vault.connect(redeemer).approve(await vault.getAddress(), REDEEM_AMOUNT_SHARES);
      await vault.connect(redeemer).requestRedeem(REDEEM_AMOUNT_SHARES);

      await underlyingAsset.mint(newDepositor.address, NEW_DEPOSIT_AMOUNT);
      await underlyingAsset.connect(newDepositor).approve(await vault.getAddress(), NEW_DEPOSIT_AMOUNT);
      await vault.connect(newDepositor).requestDeposit(NEW_DEPOSIT_AMOUNT);

      // Process epoch
      await processFullEpoch();

      // Verify redeemer got fair value
      const redeemerBalance = await underlyingAsset.balanceOf(redeemer.address);
      const expectedRedeemerAssets = (REDEEM_AMOUNT_SHARES * totalAssetsBefore) / totalSupplyBefore;
      console.log(`Redeemer expected: ${ethers.formatUnits(expectedRedeemerAssets, UNDERLYING_DECIMALS)} USDC`);
      console.log(`Redeemer received: ${ethers.formatUnits(redeemerBalance, UNDERLYING_DECIMALS)} USDC`);
      expect(redeemerBalance).to.equal(expectedRedeemerAssets);

      // Verify depositor got fair share count
      const depositorShares = await vault.balanceOf(newDepositor.address);
      console.log(`Depositor received: ${ethers.formatUnits(depositorShares, 18)} shares`);

      // Calculate exact expected depositor shares using PIT totalAssets
      // After redeem: totalAssets = 99 - 89.1 = 9.9 USDC, totalSupply = 10 shares
      // Formula: shares = assets * (totalSupply + 10^decimalsOffset) / (totalAssets + 1)
      // Query the actual totalAssetsForDeposit to match Solidity rounding
      const vaultAddress = await vault.getAddress();
      const [, totalAssetsForDeposit] = await internalStatesOrchestrator.getVaultTotalAssetsAll(vaultAddress);
      const decimalsOffset = 12n;
      const totalSupplyAfterRedeem = ethers.parseUnits("10", 18);
      const virtualSupply = totalSupplyAfterRedeem + 10n ** decimalsOffset;
      const virtualAssets = totalAssetsForDeposit + 1n;
      const expectedDepositorShares = (NEW_DEPOSIT_AMOUNT * virtualSupply) / virtualAssets;
      expect(depositorShares).to.equal(expectedDepositorShares);

      // Calculate final share price
      const finalTotalAssets = await vault.totalAssets();
      const finalTotalSupply = await vault.totalSupply();
      const finalSharePrice = (finalTotalAssets * ethers.parseUnits("1", 18)) / finalTotalSupply;
      console.log(`Final share price: ${ethers.formatUnits(finalSharePrice, UNDERLYING_DECIMALS)} USDC per share`);

      // Share price should remain exactly stable (no dilution)
      expect(finalSharePrice).to.equal(sharePrice);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle zero redemptions gracefully (deposit-only scenario)", async function () {
      // No redemptions requested, only deposit
      await underlyingAsset.mint(newDepositor.address, NEW_DEPOSIT_AMOUNT);
      await underlyingAsset.connect(newDepositor).approve(await vault.getAddress(), NEW_DEPOSIT_AMOUNT);
      await vault.connect(newDepositor).requestDeposit(NEW_DEPOSIT_AMOUNT);

      expect(await vault.pendingDeposit(await orionConfig.maxFulfillBatchSize())).to.equal(NEW_DEPOSIT_AMOUNT);
      expect(await vault.pendingRedeem(await orionConfig.maxFulfillBatchSize())).to.equal(0);

      // Process epoch
      await time.increase(epochDuration + 1n);
      await processInternalStatesOrchestrator();

      // When there are no redemptions, both totalAssets should be equal
      const vaultAddress = await vault.getAddress();
      const [totalAssetsForRedeem, totalAssetsForDeposit] =
        await internalStatesOrchestrator.getVaultTotalAssetsAll(vaultAddress);

      expect(totalAssetsForRedeem).to.equal(totalAssetsForDeposit);

      // Process fulfillment
      await processLiquidityOrchestrator();

      // Verify deposit processed normally
      const depositorShares = await vault.balanceOf(newDepositor.address);
      expect(depositorShares).to.be.gt(0);
      expect(await vault.pendingDeposit(await orionConfig.maxFulfillBatchSize())).to.equal(0);

      console.log(`Deposit-only scenario: depositor received ${ethers.formatUnits(depositorShares, 18)} shares`);
    });

    it("Should handle zero deposits gracefully (redeem-only scenario)", async function () {
      // Transfer shares for redemption
      await vault.connect(initialDepositor).transfer(redeemer.address, REDEEM_AMOUNT_SHARES);

      // Only redemption requested, no deposit
      await vault.connect(redeemer).approve(await vault.getAddress(), REDEEM_AMOUNT_SHARES);
      await vault.connect(redeemer).requestRedeem(REDEEM_AMOUNT_SHARES);

      expect(await vault.pendingRedeem(await orionConfig.maxFulfillBatchSize())).to.equal(REDEEM_AMOUNT_SHARES);
      expect(await vault.pendingDeposit(await orionConfig.maxFulfillBatchSize())).to.equal(0);

      // Capture redeemer balance before
      const balanceBefore = await underlyingAsset.balanceOf(redeemer.address);

      // Process epoch
      await processFullEpoch();

      // Verify redemption processed normally
      const balanceAfter = await underlyingAsset.balanceOf(redeemer.address);
      const assetsReceived = balanceAfter - balanceBefore;

      // Calculate exact expected redemption: 90 shares * 99 totalAssets / 100 totalSupply = 89.1 USDC
      const expectedRedeemed = ethers.parseUnits("89.1", UNDERLYING_DECIMALS);
      expect(assetsReceived).to.equal(expectedRedeemed);
      expect(await vault.pendingRedeem(await orionConfig.maxFulfillBatchSize())).to.equal(0);

      console.log(
        `Redeem-only scenario: redeemer received ${ethers.formatUnits(assetsReceived, UNDERLYING_DECIMALS)} USDC`,
      );
    });
  });
});
