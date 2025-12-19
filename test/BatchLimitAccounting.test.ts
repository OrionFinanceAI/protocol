import { expect } from "chai";
import { ethers } from "hardhat";
import "@openzeppelin/hardhat-upgrades";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  OrionTransparentVaultUpgradeable,
  InternalStatesOrchestratorUpgradeable,
  LiquidityOrchestratorUpgradeable,
} from "../typechain-types";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";

/**
 * @title Batch Limit Accounting Tests
 * @notice Tests for the critical fix to batch limit accounting mismatch
 * @dev This test suite validates that pendingDeposit() and pendingRedeem()
 *      return only the processable amount (first maxFulfillBatchSize requests) rather than
 *      the total pending amount, preventing accounting vs execution mismatch
 *
 *      Issue: The orchestrator treats all pendingDeposit/pendingRedeem entries
 *      as part of totalAssets() during preprocessing, but fulfill functions
 *      only process up to maxFulfillBatchSize requests at a time, causing accounting mismatch.
 */
describe("Batch Limit Accounting Fix", function () {
  const DEPOSIT_AMOUNT = ethers.parseUnits("100", 6); // 100 USDC
  const INITIAL_BALANCE = ethers.parseUnits("1000000", 6); // 1M USDC per user

  async function deployFixture() {
    const allSigners = await ethers.getSigners();
    const owner = allSigners[0];
    const curator = allSigners[1];
    const users = allSigners.slice(2); // Remaining signers for testing

    // Deploy upgradeable protocol using helper
    const deployed = await deployUpgradeableProtocol(owner, owner);

    const usdc = deployed.underlyingAsset;
    const config = deployed.orionConfig;
    const internalStatesOrchestrator: InternalStatesOrchestratorUpgradeable = deployed.internalStatesOrchestrator;
    const liquidityOrchestrator: LiquidityOrchestratorUpgradeable = deployed.liquidityOrchestrator;
    const vaultFactory = deployed.transparentVaultFactory;

    // Create a vault
    const vaultTx = await vaultFactory.connect(owner).createVault(
      curator.address,
      "Test Vault",
      "TVAULT",
      0, // Absolute fee type
      100, // 1% performance fee
      10, // 0.1% management fee
      ethers.ZeroAddress, // depositAccessControl
    );
    const receipt = await vaultTx.wait();
    const vaultCreatedEvent = receipt?.logs.find((log) => {
      try {
        return vaultFactory.interface.parseLog(log)?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const parsedLog = vaultCreatedEvent ? vaultFactory.interface.parseLog(vaultCreatedEvent) : null;
    const vaultAddress = parsedLog?.args[0];
    const vaultContract = await ethers.getContractAt("OrionTransparentVault", vaultAddress);
    const vault = vaultContract as unknown as OrionTransparentVaultUpgradeable;

    // Fund users with USDC and approve vault
    for (const user of users) {
      await usdc.mint(user.address, INITIAL_BALANCE);
      await usdc.connect(user).approve(await vault.getAddress(), ethers.MaxUint256);
    }

    return {
      owner,
      curator,
      users,
      usdc,
      config,
      vault,
      internalStatesOrchestrator,
      liquidityOrchestrator,
    };
  }

  describe("1. pendingDeposit() with limited users (< maxFulfillBatchSize)", function () {
    it("should return full amount when deposits < maxFulfillBatchSize", async function () {
      const { vault, users, config } = await loadFixture(deployFixture);

      // Make deposit requests with available users
      const numUsers = Math.min(users.length, 10);
      for (let i = 0; i < numUsers; i++) {
        await vault.connect(users[i]).requestDeposit(DEPOSIT_AMOUNT);
      }

      const pendingDeposit = await vault.pendingDeposit(await config.maxFulfillBatchSize());
      const expectedAmount = DEPOSIT_AMOUNT * BigInt(numUsers);

      void expect(pendingDeposit).to.equal(expectedAmount);
    });

    it("should return 0 when no deposits", async function () {
      const { vault, config } = await loadFixture(deployFixture);

      const pendingDeposit = await vault.pendingDeposit(await config.maxFulfillBatchSize());
      void expect(pendingDeposit).to.equal(0);
    });

    it("should handle varying deposit amounts correctly", async function () {
      const { vault, users, config } = await loadFixture(deployFixture);

      let expectedSum = BigInt(0);
      const numUsers = Math.min(users.length, 10);

      for (let i = 0; i < numUsers; i++) {
        const amount = DEPOSIT_AMOUNT * BigInt(i + 1);
        await vault.connect(users[i]).requestDeposit(amount);
        expectedSum += amount;
      }

      const pendingDeposit = await vault.pendingDeposit(await config.maxFulfillBatchSize());
      void expect(pendingDeposit).to.equal(expectedSum);
    });
  });

  describe("2. pendingRedeem() with limited users (< maxFulfillBatchSize)", function () {
    it("should return full shares when redeems < maxFulfillBatchSize", async function () {
      const { vault, users, usdc, liquidityOrchestrator, owner, config } = await loadFixture(deployFixture);

      const numUsers = Math.min(users.length, 10);

      // First, users deposit to get shares
      for (let i = 0; i < numUsers; i++) {
        await vault.connect(users[i]).requestDeposit(DEPOSIT_AMOUNT);
      }

      // Fund and fulfill deposits
      const totalDeposit = DEPOSIT_AMOUNT * BigInt(numUsers);
      await usdc.mint(owner.address, totalDeposit);
      await usdc.connect(owner).approve(await liquidityOrchestrator.getAddress(), totalDeposit);
      await liquidityOrchestrator.connect(owner).depositLiquidity(totalDeposit);

      // Get liquidityOrchestrator signer to call vault
      const loAddress = await liquidityOrchestrator.getAddress();
      // Set ETH balance for LO for gas
      await ethers.provider.send("hardhat_setBalance", [loAddress, ethers.toQuantity(ethers.parseEther("1.0"))]);
      const loSigner = await ethers.getImpersonatedSigner(loAddress);
      await vault.connect(loSigner).fulfillDeposit(totalDeposit);

      // Now request redeems
      for (let i = 0; i < numUsers; i++) {
        const userShares = await vault.balanceOf(users[i].address);
        // Approve vault to transfer shares for redeem
        await vault.connect(users[i]).approve(await vault.getAddress(), userShares);
        await vault.connect(users[i]).requestRedeem(userShares);
      }

      const pendingRedeem = await vault.pendingRedeem(await config.maxFulfillBatchSize());
      const totalShares = await vault.totalSupply();

      void expect(pendingRedeem).to.be.greaterThan(0);
      void expect(pendingRedeem).to.equal(totalShares);
    });

    it("should return 0 when no redeems", async function () {
      const { vault, config } = await loadFixture(deployFixture);

      const pendingRedeem = await vault.pendingRedeem(await config.maxFulfillBatchSize());
      void expect(pendingRedeem).to.equal(0);
    });
  });

  describe("3. Simulated batch limit behavior", function () {
    it("should demonstrate batch limit logic by making same user deposit multiple times", async function () {
      const { vault, users, config } = await loadFixture(deployFixture);

      // Strategy: have one user make multiple small deposits to simulate >maxFulfillBatchSize requests
      // Note: In production, requestDeposit overwrites previous request from same user,
      // but we can test the logic by checking what would happen with different amounts

      // First request
      await vault.connect(users[0]).requestDeposit(DEPOSIT_AMOUNT);
      let pending = await vault.pendingDeposit(await config.maxFulfillBatchSize());
      void expect(pending).to.equal(DEPOSIT_AMOUNT);

      // Second request - note: requestDeposit increments, not overwrites!
      const largerAmount = DEPOSIT_AMOUNT * BigInt(2);
      await vault.connect(users[0]).requestDeposit(largerAmount);
      pending = await vault.pendingDeposit(await config.maxFulfillBatchSize());
      // Total should be first deposit + second deposit
      void expect(pending).to.equal(DEPOSIT_AMOUNT + largerAmount);
    });
  });

  describe("4. Integration with fulfillDeposit", function () {
    it("fulfillDeposit should process the amount that pendingDeposit reports", async function () {
      const { vault, users, usdc, liquidityOrchestrator, owner, config } = await loadFixture(deployFixture);

      const numUsers = Math.min(users.length, 10);

      // Submit deposits
      for (let i = 0; i < numUsers; i++) {
        await vault.connect(users[i]).requestDeposit(DEPOSIT_AMOUNT);
      }

      // Get pendingDeposit
      const pendingDepositBefore = await vault.pendingDeposit(await config.maxFulfillBatchSize());
      const expectedAmount = DEPOSIT_AMOUNT * BigInt(numUsers);
      void expect(pendingDepositBefore).to.equal(expectedAmount);

      // Fulfill deposits
      await usdc.mint(owner.address, pendingDepositBefore);
      await usdc.connect(owner).approve(await liquidityOrchestrator.getAddress(), pendingDepositBefore);
      await liquidityOrchestrator.connect(owner).depositLiquidity(pendingDepositBefore);

      const loAddress = await liquidityOrchestrator.getAddress();
      // Set ETH balance for LO for gas
      await ethers.provider.send("hardhat_setBalance", [loAddress, ethers.toQuantity(ethers.parseEther("1.0"))]);
      const loSigner = await ethers.getImpersonatedSigner(loAddress);
      await vault.connect(loSigner).fulfillDeposit(pendingDepositBefore);

      // After fulfillment, pendingDeposit should be 0
      const pendingDepositAfter = await vault.pendingDeposit(await config.maxFulfillBatchSize());
      void expect(pendingDepositAfter).to.equal(0);

      // Verify shares were minted
      for (let i = 0; i < numUsers; i++) {
        const shares = await vault.balanceOf(users[i].address);
        void expect(shares).to.be.greaterThan(0);
      }
    });
  });

  describe("5. Documentation of the fix", function () {
    it("demonstrates the critical accounting fix prevents mismatch", async function () {
      const { vault, users, config, owner } = await loadFixture(deployFixture);

      await config.connect(owner).setMaxFulfillBatchSize(8n);

      // Simulate having multiple deposits (limited by available signers)
      const numUsers = Math.min(users.length, 10);

      // More deposits than processed deposits.
      void expect(await config.maxFulfillBatchSize()).to.be.lessThan(numUsers);

      for (let i = 0; i < numUsers; i++) {
        await vault.connect(users[i]).requestDeposit(DEPOSIT_AMOUNT);
      }

      // With the fix, pendingDeposit returns processable amount
      const pendingDeposit = await vault.pendingDeposit(await config.maxFulfillBatchSize());

      void expect(pendingDeposit).to.be.lessThan(DEPOSIT_AMOUNT * BigInt(numUsers));
    });
  });
});
