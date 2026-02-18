/**
 * ProtocolPause.test.ts
 *
 * This file contains comprehensive tests for the protocol-wide pause functionality
 * implemented via OpenZeppelin's Pausable contract.
 *
 * WHAT THIS FILE TESTS:
 * ======================
 *
 * 1. GUARDIAN ROLE MANAGEMENT
 *    - Setting guardian address by owner
 *    - Preventing non-owner from setting guardian
 *    - Guardian address changes emit correct events
 *
 * 2. PAUSE FUNCTIONALITY
 *    - Guardian can pause protocol operations
 *    - Owner can pause protocol operations
 *    - Non-privileged users cannot pause
 *    - ProtocolPaused event is emitted
 *
 *    - Only owner can unpause (not guardian)
 *    - Non-privileged users cannot unpause
 *    - Unpause restores protocol operations
 *    - ProtocolUnpaused event is emitted
 *
 * 4. PAUSED STATE ENFORCEMENT
 *    - InternalStateOrchestrator.performUpkeep() reverts when paused
 *    - LiquidityOrchestrator.performUpkeep() reverts when paused
 *
 * 5. INTEGRATION SCENARIOS
 *    - Pause during active epoch
 *    - Unpause and resume normal operations
 *    - Multiple pause/unpause cycles
 *    - Pause with pending deposits/redeems
 *
 */

import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";

import {
  MockUnderlyingAsset,
  MockERC4626Asset,
  ERC4626ExecutionAdapter,
  OrionConfig,
  LiquidityOrchestrator,
  OrionTransparentVault,
} from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Protocol Pause Functionality", function () {
  // Contract instances
  let underlyingAsset: MockUnderlyingAsset;
  let erc4626Asset: MockERC4626Asset;
  let adapter: ERC4626ExecutionAdapter;
  let config: OrionConfig;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let transparentVault: OrionTransparentVault;

  // Signers
  let owner: SignerWithAddress;
  let guardian: SignerWithAddress;
  let strategist: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let automationRegistry: SignerWithAddress;

  before(async function () {
    await resetNetwork();
  });

  // Test constants
  const INITIAL_SUPPLY = ethers.parseUnits("1000000", 6); // 1M USDC
  const DEPOSIT_AMOUNT = ethers.parseUnits("10000", 6); // 10k USDC
  const MIN_DEPOSIT = ethers.parseUnits("100", 6); // 100 USDC
  const MIN_REDEEM = ethers.parseUnits("100", 18); // 100 shares

  beforeEach(async function () {
    // Get signers
    [owner, guardian, strategist, user1, user2, automationRegistry] = await ethers.getSigners();

    const deployed = await deployUpgradeableProtocol(owner, undefined, automationRegistry);

    underlyingAsset = deployed.underlyingAsset;
    config = deployed.orionConfig;
    liquidityOrchestrator = deployed.liquidityOrchestrator;

    // Mint tokens to users
    await underlyingAsset.mint(user1.address, INITIAL_SUPPLY);
    await underlyingAsset.mint(user2.address, INITIAL_SUPPLY);

    // Deploy ERC4626 Asset (e.g., sDAI)
    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    const erc4626AssetDeployed = await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Savings DAI",
      "sDAI",
    );
    await erc4626AssetDeployed.waitForDeployment();
    erc4626Asset = erc4626AssetDeployed as unknown as MockERC4626Asset;

    // Deploy Price Adapter
    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    const priceAdapterDeployed = await MockPriceAdapterFactory.deploy();
    await priceAdapterDeployed.waitForDeployment();

    // Deploy Mock Swap Executor
    const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
    const MockExecutionAdapter = await MockExecutionAdapterFactory.deploy();
    await MockExecutionAdapter.waitForDeployment();

    // Deploy Execution Adapter
    const AdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
    const adapterDeployed = await AdapterFactory.deploy(await config.getAddress());
    await adapterDeployed.waitForDeployment();
    adapter = adapterDeployed as unknown as ERC4626ExecutionAdapter;

    // NOW we can configure protocol parameters (these check isSystemIdle())
    await config.setMinDepositAmount(MIN_DEPOSIT);
    await config.setMinRedeemAmount(MIN_REDEEM);

    // Whitelist ERC4626 asset with its adapters
    await config.addWhitelistedAsset(
      await erc4626Asset.getAddress(),
      await priceAdapterDeployed.getAddress(),
      await adapter.getAddress(),
    );

    // Set guardian
    await config.setGuardian(guardian.address);

    // Get vault factory from deployed protocol
    const vaultFactory = deployed.transparentVaultFactory;

    // Create vault via factory (automatically registers it)
    const vaultAddress = await vaultFactory.connect(owner).createVault.staticCall(
      strategist.address, // strategist
      "Orion Test Vault", // name
      "OTV", // symbol
      0, // feeType: ABSOLUTE
      500, // performanceFee: 5%
      100, // managementFee: 1%
      ethers.ZeroAddress, // depositAccessControl
    );

    await vaultFactory
      .connect(owner)
      .createVault(strategist.address, "Orion Test Vault", "OTV", 0, 500, 100, ethers.ZeroAddress);

    transparentVault = (await ethers.getContractAt(
      "OrionTransparentVault",
      vaultAddress,
    )) as unknown as OrionTransparentVault;

    // Provide liquidity to the protocol
    const liquidityAmount = ethers.parseUnits("100000", 6); // 100k USDC
    await underlyingAsset.mint(owner.address, liquidityAmount);
    await underlyingAsset.connect(owner).approve(await liquidityOrchestrator.getAddress(), liquidityAmount);
    await liquidityOrchestrator.depositLiquidity(liquidityAmount);

    // Approve vault for user deposits
    await underlyingAsset.connect(user1).approve(await transparentVault.getAddress(), INITIAL_SUPPLY);
    await underlyingAsset.connect(user2).approve(await transparentVault.getAddress(), INITIAL_SUPPLY);
  });

  describe("1. Guardian Role Management", function () {
    it("should allow owner to set guardian", async function () {
      const newGuardian = user1.address;
      await expect(config.connect(owner).setGuardian(newGuardian))
        .to.emit(config, "GuardianUpdated")
        .withArgs(newGuardian);

      expect(await config.guardian()).to.equal(newGuardian);
    });

    it("should prevent non-owner from setting guardian", async function () {
      await expect(config.connect(user1).setGuardian(user2.address)).to.be.revertedWithCustomError(
        config,
        "OwnableUnauthorizedAccount",
      );
    });

    it("should update guardian address correctly", async function () {
      expect(await config.guardian()).to.equal(guardian.address);

      await config.connect(owner).setGuardian(user1.address);
      expect(await config.guardian()).to.equal(user1.address);
    });
  });

  describe("2. Pause All Functionality", function () {
    it("should allow guardian to pause all protocol operations", async function () {
      await expect(liquidityOrchestrator.connect(guardian).pause())
        .to.emit(liquidityOrchestrator, "Paused")
        .withArgs(guardian.address);

      // Verify orchestrators are paused
      void expect(await liquidityOrchestrator.paused()).to.be.true;
    });

    it("should allow owner to pause all protocol operations", async function () {
      await expect(liquidityOrchestrator.connect(owner).pause())
        .to.emit(liquidityOrchestrator, "Paused")
        .withArgs(owner.address);

      // Verify all contracts are paused
      void expect(await liquidityOrchestrator.paused()).to.be.true;
    });

    it("should prevent non-privileged users from pausing", async function () {
      await expect(liquidityOrchestrator.connect(user1).pause()).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "NotAuthorized",
      );

      // Verify nothing is paused
      void expect(await liquidityOrchestrator.paused()).to.be.false;
    });
  });

  describe("3. Unpause All Functionality", function () {
    beforeEach(async function () {
      // Pause protocol first
      await liquidityOrchestrator.connect(guardian).pause();
    });

    it("should allow owner to unpause all protocol operations", async function () {
      await expect(liquidityOrchestrator.connect(owner).unpause())
        .to.emit(liquidityOrchestrator, "Unpaused")
        .withArgs(owner.address);

      // Verify orchestrators are unpaused
      void expect(await liquidityOrchestrator.paused()).to.be.false;
    });

    it("should prevent guardian from unpausing (only owner)", async function () {
      await expect(liquidityOrchestrator.connect(guardian).unpause()).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "OwnableUnauthorizedAccount",
      );

      // Verify everything is still paused
      void expect(await liquidityOrchestrator.paused()).to.be.true;
    });

    it("should prevent non-owner from unpausing", async function () {
      await expect(liquidityOrchestrator.connect(user1).unpause()).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "OwnableUnauthorizedAccount",
      );

      // Verify everything is still paused
      void expect(await liquidityOrchestrator.paused()).to.be.true;
    });
  });

  describe("4. Paused State Enforcement", function () {
    beforeEach(async function () {
      // Pause protocol
      await liquidityOrchestrator.connect(guardian).pause();
    });

    it("should prevent LiquidityOrchestrator.performUpkeep() when paused", async function () {
      await expect(
        liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x", "0x", "0x"),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "EnforcedPause");
    });

    it("should allow operations to resume after unpause", async function () {
      // Unpause
      await liquidityOrchestrator.connect(owner).unpause();

      // Now operations should work
      await expect(transparentVault.connect(user1).requestDeposit(DEPOSIT_AMOUNT)).to.not.be.reverted;

      // Verify deposit was successful
      expect(await transparentVault.pendingDeposit(await config.maxFulfillBatchSize())).to.equal(DEPOSIT_AMOUNT);
    });
  });

  describe("5. Integration Scenarios", function () {
    it("should allow resuming operations after unpause", async function () {
      // Make initial deposit
      await transparentVault.connect(user1).requestDeposit(DEPOSIT_AMOUNT);

      // Pause and unpause
      await liquidityOrchestrator.connect(guardian).pause();
      await liquidityOrchestrator.connect(owner).unpause();

      // User can now cancel their request
      await expect(transparentVault.connect(user1).cancelDepositRequest(DEPOSIT_AMOUNT)).to.not.be.reverted;

      expect(await transparentVault.pendingDeposit(await config.maxFulfillBatchSize())).to.equal(0);
    });

    it("should handle multiple pause/unpause cycles", async function () {
      // Cycle 1: Pause and unpause
      await liquidityOrchestrator.connect(guardian).pause();
      void expect(await liquidityOrchestrator.paused()).to.be.true;

      await liquidityOrchestrator.connect(owner).unpause();
      void expect(await liquidityOrchestrator.paused()).to.be.false;
      // Cycle 2: Pause and unpause again
      await liquidityOrchestrator.connect(owner).pause(); // Owner can also pause
      void expect(await liquidityOrchestrator.paused()).to.be.true;

      await liquidityOrchestrator.connect(owner).unpause();
      void expect(await liquidityOrchestrator.paused()).to.be.false;

      await time.increase(await liquidityOrchestrator.epochDuration());

      await expect(liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x", "0x", "0x")).to.not.be
        .reverted;
    });

    it("should preserve state across pause/unpause", async function () {
      // Setup initial state
      await transparentVault.connect(user1).requestDeposit(DEPOSIT_AMOUNT);
      const depositBefore = await transparentVault.pendingDeposit(await config.maxFulfillBatchSize());

      // Pause
      await liquidityOrchestrator.connect(guardian).pause();

      // State should be unchanged
      expect(await transparentVault.pendingDeposit(await config.maxFulfillBatchSize())).to.equal(depositBefore);

      // Unpause
      await liquidityOrchestrator.connect(owner).unpause();

      // State should still be unchanged
      expect(await transparentVault.pendingDeposit(await config.maxFulfillBatchSize())).to.equal(depositBefore);

      // Can still interact with preserved state
      await transparentVault.connect(user1).cancelDepositRequest(DEPOSIT_AMOUNT);
      expect(await transparentVault.pendingDeposit(await config.maxFulfillBatchSize())).to.equal(0);
    });

    it("should block epoch progression when paused", async function () {
      // Start an epoch
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x", "0x", "0x");

      // Pause protocol
      await liquidityOrchestrator.connect(guardian).pause();

      // Cannot continue epoch
      await expect(
        liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x", "0x", "0x"),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "EnforcedPause");

      await expect(
        liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x", "0x", "0x"),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "EnforcedPause");
    });
  });
});
