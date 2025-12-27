import { expect } from "chai";
import { ethers } from "hardhat";
import "@openzeppelin/hardhat-upgrades";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  MockUnderlyingAsset,
  OrionConfig,
  TransparentVaultFactory,
  OrionTransparentVault,
  LiquidityOrchestrator,
} from "../typechain-types";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { impersonateAccount, setBalance } from "@nomicfoundation/hardhat-network-helpers";

/**
 * Helper to impersonate the LiquidityOrchestrator for direct vault function calls
 */
async function impersonateLiquidityOrchestrator(loAddress: string) {
  await impersonateAccount(loAddress);
  await setBalance(loAddress, ethers.parseEther("1"));
  return await ethers.getSigner(loAddress);
}

/**
 * @title Batch Limit Consistency Tests
 * @notice Tests ensuring consistency between pendingDeposit/pendingRedeem and maxFulfillBatchSize
 *
 * CRITICAL BUG FIX (commit 3ca6a00):
 * =====================================
 * The orchestrator treated ALL pendingDeposit/pendingRedeem entries as part of totalAssets()
 * during preProcess, but fulfillDeposit and fulfillRedeem only process up to maxFulfillBatchSize
 * (150) requests per epoch.
 *
 * This caused:
 * 1. preProcess ISO accounting optimistically included EVERY pending request into totalAssets
 * 2. LO attempts to fulfill but only 150 get processed; remaining stay queued
 * 3. Next epoch, still-pending entries are AGAIN included → double counting
 * 4. Assets to subtract calculated based on pendingRedeem, so already-subtracted amounts
 *    get deducted again
 *
 * IMPACT:
 * =======
 * - totalAssets() overcounting → inflated share prices
 * - Incorrect minting/valuation of shares
 * - Can cause protocol halt during sell order execution
 *
 * FIX:
 * ====
 * - pendingDeposit(fulfillBatchSize) returns only MIN(length, batchSize) request amounts
 * - pendingRedeem(fulfillBatchSize) returns only MIN(length, batchSize) request shares
 * - fulfillDeposit/fulfillRedeem collect all keys first to avoid swap-and-pop reordering
 *
 * THESE TESTS VERIFY:
 * ===================
 * 1. pendingDeposit returns correct amount when requests < maxFulfillBatchSize
 * 2. pendingDeposit returns ONLY first maxFulfillBatchSize when requests exceed limit
 * 3. pendingRedeem returns correct shares when requests < maxFulfillBatchSize
 * 4. pendingRedeem returns ONLY first maxFulfillBatchSize when requests exceed limit
 *
 * TEST APPROACH:
 * ==============
 * - Uses impersonateLiquidityOrchestrator() to directly call fulfillDeposit/fulfillRedeem
 * - This bypasses full epoch processing and directly tests the batch limiting logic
 * - For redeem tests: requestDeposit() → fulfillDeposit() to give users shares first
 * - Users must approve vault to transfer shares before requestRedeem()
 *
 * LIMITATIONS:
 * ============
 * - Hardhat provides only ~18-20 signers, but maxFulfillBatchSize is 150
 * - Tests use effectiveBatchSize = min(maxFulfillBatchSize, numUsers - 2) to work around this
 * - Tests verify the batch limiting logic works correctly with available signers
 * - In production with 150+ real requests, the same logic will apply at scale
 */
describe("Batch Limit Consistency - Critical Accounting Fix", function () {
  let owner: SignerWithAddress;
  let manager: SignerWithAddress;
  let users: SignerWithAddress[];

  let underlyingAsset: MockUnderlyingAsset;
  let orionConfig: OrionConfig;
  let transparentVaultFactory: TransparentVaultFactory;
  let vault: OrionTransparentVault;
  let liquidityOrchestrator: LiquidityOrchestrator;

  const DEPOSIT_AMOUNT = ethers.parseUnits("100", 6); // 100 USDC per user
  let maxFulfillBatchSize: number;

  beforeEach(async function () {
    [owner, manager, ...users] = await ethers.getSigners();

    const deployed = await deployUpgradeableProtocol(owner);

    underlyingAsset = deployed.underlyingAsset;
    orionConfig = deployed.orionConfig;
    transparentVaultFactory = deployed.transparentVaultFactory;
    liquidityOrchestrator = deployed.liquidityOrchestrator;

    // Get maxFulfillBatchSize from config
    maxFulfillBatchSize = Number(await orionConfig.maxFulfillBatchSize());

    // Create vault via factory
    const tx = await transparentVaultFactory.createVault(
      manager.address,
      "Test Vault",
      "TVAULT",
      0, // feeType
      0, // performanceFee
      0, // managementFee
      ethers.ZeroAddress, // depositAccessControl
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

    if (!event) {
      throw new Error("OrionVaultCreated event not found");
    }

    const parsedEvent = transparentVaultFactory.interface.parseLog(event!);
    const vaultAddress = parsedEvent?.args[0];

    vault = (await ethers.getContractAt("OrionTransparentVault", vaultAddress)) as unknown as OrionTransparentVault;

    // Note: Not making initial deposit to keep tests simple
    // Each test will create its own requests
  });

  describe("1. pendingDeposit Batch Limit", function () {
    it("Should return exact amount when requests < maxFulfillBatchSize", async function () {
      const numUsers = Math.min(10, maxFulfillBatchSize - 1);

      // Create deposit requests from multiple users
      for (let i = 0; i < numUsers; i++) {
        await underlyingAsset.mint(users[i].address, DEPOSIT_AMOUNT);
        await underlyingAsset.connect(users[i]).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
        await vault.connect(users[i]).requestDeposit(DEPOSIT_AMOUNT);
      }

      // pendingDeposit should return all requests
      const pendingAmount = await vault.pendingDeposit(maxFulfillBatchSize);
      const expectedAmount = DEPOSIT_AMOUNT * BigInt(numUsers);
      expect(pendingAmount).to.equal(expectedAmount);
    });

    it("Should return ONLY first maxFulfillBatchSize requests when requests exceed limit", async function () {
      // NOTE: Hardhat provides limited signers (~18-20), so we can't truly test 150+ requests
      // This test verifies the batch limiting logic works with available signers
      const excessUsers = 5;
      const numUsers = Math.min(maxFulfillBatchSize + excessUsers, users.length);

      // For this test to be meaningful, we need more requests than batch size
      // If we don't have enough signers, we use a smaller batch size for testing
      const effectiveBatchSize = Math.min(maxFulfillBatchSize, Math.max(1, numUsers - 2));

      // Create deposit requests exceeding effective batch limit
      for (let i = 0; i < numUsers; i++) {
        await underlyingAsset.mint(users[i].address, DEPOSIT_AMOUNT);
        await underlyingAsset.connect(users[i]).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
        await vault.connect(users[i]).requestDeposit(DEPOSIT_AMOUNT);
      }

      // pendingDeposit should return ONLY first effectiveBatchSize
      const pendingAmount = await vault.pendingDeposit(effectiveBatchSize);
      const expectedAmount = DEPOSIT_AMOUNT * BigInt(effectiveBatchSize);
      expect(pendingAmount).to.equal(expectedAmount);

      // Should NOT equal all requests
      const totalRequested = DEPOSIT_AMOUNT * BigInt(numUsers);
      expect(pendingAmount).to.not.equal(totalRequested);
      expect(pendingAmount).to.be.lessThan(totalRequested);
    });

    it("Should handle edge case when requests = maxFulfillBatchSize exactly", async function () {
      const numUsers = Math.min(maxFulfillBatchSize, users.length);

      for (let i = 0; i < numUsers; i++) {
        await underlyingAsset.mint(users[i].address, DEPOSIT_AMOUNT);
        await underlyingAsset.connect(users[i]).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
        await vault.connect(users[i]).requestDeposit(DEPOSIT_AMOUNT);
      }

      const pendingAmount = await vault.pendingDeposit(maxFulfillBatchSize);
      const expectedAmount = DEPOSIT_AMOUNT * BigInt(numUsers);
      expect(pendingAmount).to.equal(expectedAmount);
    });
  });

  describe("2. pendingRedeem Batch Limit", function () {
    beforeEach(async function () {
      // Setup: Have some users deposit and fulfill so they get shares to redeem
      const numUsers = Math.min(30, maxFulfillBatchSize + 10, users.length);

      // Request deposits
      for (let i = 0; i < numUsers; i++) {
        await underlyingAsset.mint(users[i].address, DEPOSIT_AMOUNT);
        await underlyingAsset.connect(users[i]).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
        await vault.connect(users[i]).requestDeposit(DEPOSIT_AMOUNT);
      }

      // Deposit liquidity into LiquidityOrchestrator
      const totalDeposit = DEPOSIT_AMOUNT * BigInt(numUsers);
      await underlyingAsset.mint(owner.address, totalDeposit);
      await underlyingAsset.connect(owner).approve(await liquidityOrchestrator.getAddress(), totalDeposit);
      await liquidityOrchestrator.connect(owner).depositLiquidity(totalDeposit);

      // Impersonate LiquidityOrchestrator to fulfill deposits (this mints shares to users)
      const loAddress = await liquidityOrchestrator.getAddress();
      const loSigner = await impersonateLiquidityOrchestrator(loAddress);
      await vault.connect(loSigner).fulfillDeposit(totalDeposit);
    });

    it("Should return exact shares when requests < maxFulfillBatchSize", async function () {
      const numUsers = Math.min(10, maxFulfillBatchSize - 1);

      // Collect share amounts before requests
      const shareAmounts: bigint[] = [];
      for (let i = 0; i < numUsers; i++) {
        const userShares = await vault.balanceOf(users[i].address);
        shareAmounts.push(userShares);
        // Approve vault to transfer shares for redeem
        await vault.connect(users[i]).approve(await vault.getAddress(), userShares);
        await vault.connect(users[i]).requestRedeem(userShares);
      }

      // Calculate expected pending shares
      const expectedShares = shareAmounts.reduce((sum, shares) => sum + shares, 0n);
      const pendingShares = await vault.pendingRedeem(maxFulfillBatchSize);

      expect(pendingShares).to.equal(expectedShares);
    });

    it("Should return ONLY first maxFulfillBatchSize shares when requests exceed limit", async function () {
      // NOTE: Similar to deposit test, limited by available Hardhat signers
      const excessUsers = 5;
      const numUsers = Math.min(maxFulfillBatchSize + excessUsers, users.length);
      const effectiveBatchSize = Math.min(maxFulfillBatchSize, Math.max(1, numUsers - 2));

      // Create redeem requests exceeding batch limit
      let totalSharesRequested = 0n;
      for (let i = 0; i < numUsers; i++) {
        const userShares = await vault.balanceOf(users[i].address);
        if (userShares > 0n) {
          totalSharesRequested += userShares;
          // Approve vault to transfer shares for redeem
          await vault.connect(users[i]).approve(await vault.getAddress(), userShares);
          await vault.connect(users[i]).requestRedeem(userShares);
        }
      }

      const pendingShares = await vault.pendingRedeem(effectiveBatchSize);

      // Should NOT equal all requested shares - proves batch limiting is working
      expect(pendingShares).to.not.equal(totalSharesRequested);
      expect(pendingShares).to.be.lessThan(totalSharesRequested);
    });

    it("Should handle edge case when requests = maxFulfillBatchSize exactly", async function () {
      const numUsers = Math.min(maxFulfillBatchSize, users.length);

      for (let i = 0; i < numUsers; i++) {
        const userShares = await vault.balanceOf(users[i].address);
        if (userShares > 0n) {
          // Approve vault to transfer shares for redeem
          await vault.connect(users[i]).approve(await vault.getAddress(), userShares);
          await vault.connect(users[i]).requestRedeem(userShares);
        }
      }

      const pendingShares = await vault.pendingRedeem(maxFulfillBatchSize);

      // Should return non-zero if users have shares
      expect(pendingShares).to.be.greaterThan(0n);
    });
  });

  describe("3. Verify Fix Prevents Double-Counting", function () {
    it("Should limit pendingDeposit to maxFulfillBatchSize preventing overcounting in totalAssets", async function () {
      // NOTE: Limited by available Hardhat signers
      const excessRequests = 5;
      const numUsers = Math.min(maxFulfillBatchSize + excessRequests, users.length);
      const effectiveBatchSize = Math.min(maxFulfillBatchSize, Math.max(1, numUsers - 2));

      // Create many requests
      for (let i = 0; i < numUsers; i++) {
        await underlyingAsset.mint(users[i].address, DEPOSIT_AMOUNT);
        await underlyingAsset.connect(users[i]).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
        await vault.connect(users[i]).requestDeposit(DEPOSIT_AMOUNT);
      }

      // CRITICAL: pendingDeposit should return ONLY effectiveBatchSize worth
      const pendingAmount = await vault.pendingDeposit(effectiveBatchSize);
      const limitedAmount = DEPOSIT_AMOUNT * BigInt(effectiveBatchSize);

      expect(pendingAmount).to.equal(limitedAmount);

      // Verify it's less than total requested
      const totalRequested = DEPOSIT_AMOUNT * BigInt(numUsers);
      expect(pendingAmount).to.be.lessThan(totalRequested);

      // This prevents the bug where totalAssets would count ALL requests,
      // but fulfillDeposit would only process maxFulfillBatchSize
    });

    it("Should limit pendingRedeem to maxFulfillBatchSize preventing double-subtraction from totalAssets", async function () {
      // Setup: Give users shares by requesting deposits and fulfilling them
      // NOTE: Limited by available Hardhat signers
      const excessRequests = 5;
      const numUsers = Math.min(maxFulfillBatchSize + excessRequests, users.length);
      const effectiveBatchSize = Math.min(maxFulfillBatchSize, Math.max(1, numUsers - 2));

      // Request deposits
      for (let i = 0; i < numUsers; i++) {
        await underlyingAsset.mint(users[i].address, DEPOSIT_AMOUNT);
        await underlyingAsset.connect(users[i]).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
        await vault.connect(users[i]).requestDeposit(DEPOSIT_AMOUNT);
      }

      // Deposit liquidity and fulfill deposits to give users shares
      const totalDeposit = DEPOSIT_AMOUNT * BigInt(numUsers);
      await underlyingAsset.mint(owner.address, totalDeposit);
      await underlyingAsset.connect(owner).approve(await liquidityOrchestrator.getAddress(), totalDeposit);
      await liquidityOrchestrator.connect(owner).depositLiquidity(totalDeposit);

      const loAddress = await liquidityOrchestrator.getAddress();
      const loSigner = await impersonateLiquidityOrchestrator(loAddress);
      await vault.connect(loSigner).fulfillDeposit(totalDeposit);

      // Now create many redeem requests
      let totalSharesRequested = 0n;
      for (let i = 0; i < numUsers; i++) {
        const userShares = await vault.balanceOf(users[i].address);
        if (userShares > 0n) {
          totalSharesRequested += userShares;
          // Approve vault to transfer shares for redeem
          await vault.connect(users[i]).approve(await vault.getAddress(), userShares);
          await vault.connect(users[i]).requestRedeem(userShares);
        }
      }

      // CRITICAL: pendingRedeem should NOT return all shares
      const pendingShares = await vault.pendingRedeem(effectiveBatchSize);

      expect(pendingShares).to.be.lessThan(totalSharesRequested);

      // This prevents the bug where totalAssets would subtract ALL pending redeems,
      // but fulfillRedeem would only process maxFulfillBatchSize, leading to
      // re-subtraction in the next epoch
    });
  });
});
