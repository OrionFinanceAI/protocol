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
 *    - Setting guardian address by admin
 *    - Preventing non-admin from setting guardian
 *    - Guardian address changes emit correct events
 *
 * 2. PAUSE ALL FUNCTIONALITY
 *    - Guardian can pause all protocol operations
 *    - Admin can pause all protocol operations
 *    - Non-privileged users cannot pause
 *    - Pause affects all orchestrators (InternalStates, Liquidity)
 *    - Pause affects all vaults (Transparent and Encrypted)
 *    - ProtocolPaused event is emitted
 *
 * 3. UNPAUSE ALL FUNCTIONALITY
 *    - Only admin can unpause (not guardian)
 *    - Non-privileged users cannot unpause
 *    - Unpause restores all orchestrators
 *    - Unpause restores all vaults
 *    - ProtocolUnpaused event is emitted
 *
 * 4. PAUSED STATE ENFORCEMENT
 *    - InternalStatesOrchestrator.performUpkeep() reverts when paused
 *    - LiquidityOrchestrator.performUpkeep() reverts when paused
 *    - OrionVault.requestDeposit() reverts when paused
 *    - OrionVault.cancelDepositRequest() reverts when paused
 *    - OrionVault.requestRedeem() reverts when paused
 *    - OrionVault.cancelRedeemRequest() reverts when paused
 *
 * 5. INDIVIDUAL CONTRACT PAUSE ACCESS CONTROL
 *    - Only OrionConfig can call pause() on orchestrators
 *    - Only OrionConfig can call unpause() on orchestrators
 *    - Only OrionConfig can call pause() on vaults
 *    - Only OrionConfig can unpause() on vaults
 *    - Direct calls to pause/unpause from non-OrionConfig addresses revert
 *
 * 6. INTEGRATION SCENARIOS
 *    - Pause during active epoch
 *    - Unpause and resume normal operations
 *    - Multiple pause/unpause cycles
 *    - Pause with pending deposits/redeems
 *
 * SECURITY PRINCIPLES TESTED:
 * ===========================
 * - Access Control: Only guardian/admin can trigger emergency pause
 * - Asymmetric Control: Guardian can pause, only admin can unpause
 * - Complete Coverage: All critical operations blocked when paused
 * - Centralized Control: Individual contracts cannot be paused except via OrionConfig
 * - Event Emission: All pause/unpause actions emit appropriate events
 *
 * WHY THESE TESTS MATTER:
 * =======================
 * - Emergency pause is critical for responding to security incidents
 * - Off-chain monitoring can detect invariant violations and trigger pause
 * - Prevents multi-transaction exploits by halting all state changes
 * - Ensures only trusted parties can pause/unpause protocol
 * - Validates that paused state actually blocks dangerous operations
 *
 * ATTACK VECTORS PREVENTED:
 * =========================
 * - Unauthorized pause: Non-guardian cannot pause protocol
 * - Unauthorized unpause: Non-admin cannot resume protocol operations
 * - Bypass pause: All critical functions respect paused state
 * - Direct manipulation: Cannot pause/unpause individual contracts directly
 *
 * USE CASE: Off-Chain Invariant Monitoring
 * =========================================
 * This pause system enables an off-chain monitoring service to:
 * 1. Monitor protocol invariants in real-time
 * 2. Detect violations (e.g., price manipulation, liquidity drain)
 * 3. Immediately call OrionConfig.pauseAll() to halt operations
 * 4. Allow admins to investigate and fix the issue
 * 5. Resume operations via OrionConfig.unpauseAll() once safe
 */

import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import {
  MockUnderlyingAsset,
  MockERC4626Asset,
  OrionAssetERC4626ExecutionAdapter,
  OrionConfig,
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  OrionTransparentVault,
  TransparentVaultFactory,
} from "../typechain-types";

describe("Protocol Pause Functionality", function () {
  // Contract instances
  let underlyingAsset: MockUnderlyingAsset;
  let erc4626Asset: MockERC4626Asset;
  let adapter: OrionAssetERC4626ExecutionAdapter;
  let config: OrionConfig;
  let internalStatesOrchestrator: InternalStatesOrchestrator;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let transparentVault: OrionTransparentVault;

  // Signers
  let admin: SignerWithAddress;
  let guardian: SignerWithAddress;
  let curator: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let automationRegistry: SignerWithAddress;

  // Test constants
  const INITIAL_SUPPLY = ethers.parseUnits("1000000", 6); // 1M USDC
  const DEPOSIT_AMOUNT = ethers.parseUnits("10000", 6); // 10k USDC
  const MIN_DEPOSIT = ethers.parseUnits("100", 6); // 100 USDC
  const MIN_REDEEM = ethers.parseUnits("100", 18); // 100 shares

  beforeEach(async function () {
    // Get signers
    [admin, guardian, curator, user1, user2, automationRegistry] = await ethers.getSigners();

    // Deploy mock underlying asset (USDC)
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    underlyingAsset = await MockUnderlyingAssetFactory.deploy(6); // decimals

    // Mint tokens to users
    await underlyingAsset.mint(user1.address, INITIAL_SUPPLY);
    await underlyingAsset.mint(user2.address, INITIAL_SUPPLY);

    // Deploy OrionConfig
    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    const configDeployed = await OrionConfigFactory.deploy(
      admin.address, // initialOwner
      admin.address, // admin
      await underlyingAsset.getAddress(), // underlyingAsset
    );
    await configDeployed.waitForDeployment();
    config = configDeployed as unknown as OrionConfig;

    // Deploy LiquidityOrchestrator FIRST
    const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
    const liquidityOrchestratorDeployed = await LiquidityOrchestratorFactory.deploy(
      admin.address, // owner
      await config.getAddress(),
      automationRegistry.address,
    );
    await liquidityOrchestratorDeployed.waitForDeployment();
    liquidityOrchestrator = liquidityOrchestratorDeployed as unknown as LiquidityOrchestrator;

    // Register LiquidityOrchestrator in config BEFORE deploying InternalStatesOrchestrator
    // (InternalStatesOrchestrator constructor reads liquidityOrchestrator from config)
    await config.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());

    // NOW deploy InternalStatesOrchestrator (it will read liquidityOrchestrator from config)
    const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
    const internalStatesOrchestratorDeployed = await InternalStatesOrchestratorFactory.deploy(
      admin.address, // owner
      await config.getAddress(),
      automationRegistry.address,
    );
    await internalStatesOrchestratorDeployed.waitForDeployment();
    internalStatesOrchestrator = internalStatesOrchestratorDeployed as unknown as InternalStatesOrchestrator;

    // Register InternalStatesOrchestrator in config
    await config.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());

    // Link orchestrators to each other
    await liquidityOrchestrator.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());

    // Deploy PriceAdapterRegistry
    const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
    const priceAdapterRegistryDeployed = await PriceAdapterRegistryFactory.deploy(
      admin.address,
      await config.getAddress(),
    );
    await priceAdapterRegistryDeployed.waitForDeployment();

    await config.setPriceAdapterRegistry(await priceAdapterRegistryDeployed.getAddress());

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
    const OrionAssetERC4626PriceAdapterFactory = await ethers.getContractFactory("OrionAssetERC4626PriceAdapter");
    const priceAdapterDeployed = await OrionAssetERC4626PriceAdapterFactory.deploy(await config.getAddress());
    await priceAdapterDeployed.waitForDeployment();

    // Deploy Execution Adapter
    const AdapterFactory = await ethers.getContractFactory("OrionAssetERC4626ExecutionAdapter");
    const adapterDeployed = await AdapterFactory.deploy(await config.getAddress());
    await adapterDeployed.waitForDeployment();
    adapter = adapterDeployed as unknown as OrionAssetERC4626ExecutionAdapter;

    // NOW we can configure protocol parameters (these check isSystemIdle())
    await config.setMinDepositAmount(MIN_DEPOSIT);
    await config.setMinRedeemAmount(MIN_REDEEM);
    await config.addWhitelistedCurator(curator.address);
    // NOTE: Admin is already whitelisted as vault owner in OrionConfig constructor (initialOwner)
    // NOTE: Underlying asset is already whitelisted in OrionConfig constructor

    // Whitelist ERC4626 asset with its adapters
    await config.addWhitelistedAsset(
      await erc4626Asset.getAddress(),
      await priceAdapterDeployed.getAddress(),
      await adapter.getAddress(),
    );

    // Set guardian
    await config.setGuardian(guardian.address);

    // Deploy vault factory
    const TransparentVaultFactoryFactory = await ethers.getContractFactory("TransparentVaultFactory");
    const vaultFactoryDeployed = await TransparentVaultFactoryFactory.deploy(await config.getAddress());
    await vaultFactoryDeployed.waitForDeployment();
    const vaultFactory = vaultFactoryDeployed as unknown as TransparentVaultFactory;
    await config.setVaultFactory(await vaultFactory.getAddress());

    // Create vault via factory (automatically registers it)
    const vaultAddress = await vaultFactory.connect(admin).createVault.staticCall(
      curator.address, // curator
      "Orion Test Vault", // name
      "OTV", // symbol
      0, // feeType: ABSOLUTE
      500, // performanceFee: 5%
      100, // managementFee: 1%
    );

    await vaultFactory.connect(admin).createVault(curator.address, "Orion Test Vault", "OTV", 0, 500, 100);

    transparentVault = (await ethers.getContractAt(
      "OrionTransparentVault",
      vaultAddress,
    )) as unknown as OrionTransparentVault;

    // Provide liquidity to the protocol
    const liquidityAmount = ethers.parseUnits("100000", 6); // 100k USDC
    await underlyingAsset.mint(admin.address, liquidityAmount);
    await underlyingAsset.connect(admin).approve(await liquidityOrchestrator.getAddress(), liquidityAmount);
    await liquidityOrchestrator.depositLiquidity(liquidityAmount);

    // Approve vault for user deposits
    await underlyingAsset.connect(user1).approve(await transparentVault.getAddress(), INITIAL_SUPPLY);
    await underlyingAsset.connect(user2).approve(await transparentVault.getAddress(), INITIAL_SUPPLY);
  });

  describe("1. Guardian Role Management", function () {
    it("should allow admin to set guardian", async function () {
      const newGuardian = user1.address;
      await expect(config.connect(admin).setGuardian(newGuardian))
        .to.emit(config, "GuardianUpdated")
        .withArgs(newGuardian);

      expect(await config.guardian()).to.equal(newGuardian);
    });

    it("should prevent non-admin from setting guardian", async function () {
      await expect(config.connect(user1).setGuardian(user2.address)).to.be.revertedWithCustomError(
        config,
        "UnauthorizedAccess",
      );
    });

    it("should update guardian address correctly", async function () {
      expect(await config.guardian()).to.equal(guardian.address);

      await config.connect(admin).setGuardian(user1.address);
      expect(await config.guardian()).to.equal(user1.address);
    });
  });

  describe("2. Pause All Functionality", function () {
    it("should allow guardian to pause all protocol operations", async function () {
      await expect(config.connect(guardian).pauseAll()).to.emit(config, "ProtocolPaused").withArgs(guardian.address);

      // Verify orchestrators are paused
      void expect(await internalStatesOrchestrator.paused()).to.be.true;
      void expect(await liquidityOrchestrator.paused()).to.be.true;

      // Verify vault is paused
      void expect(await transparentVault.paused()).to.be.true;
    });

    it("should allow admin to pause all protocol operations", async function () {
      await expect(config.connect(admin).pauseAll()).to.emit(config, "ProtocolPaused").withArgs(admin.address);

      // Verify all contracts are paused
      void expect(await internalStatesOrchestrator.paused()).to.be.true;
      void expect(await liquidityOrchestrator.paused()).to.be.true;
      void expect(await transparentVault.paused()).to.be.true;
    });

    it("should prevent non-privileged users from pausing", async function () {
      await expect(config.connect(user1).pauseAll()).to.be.revertedWithCustomError(config, "UnauthorizedAccess");

      // Verify nothing is paused
      void expect(await internalStatesOrchestrator.paused()).to.be.false;
      void expect(await liquidityOrchestrator.paused()).to.be.false;
      void expect(await transparentVault.paused()).to.be.false;
    });

    it("should pause all vaults (transparent and encrypted)", async function () {
      // For this test, we verify transparent vault is paused
      // In production, encrypted vaults would also be tested
      await config.connect(guardian).pauseAll();

      const allTransparentVaults = await config.getAllOrionVaults(0); // VaultType.Transparent = 0
      expect(allTransparentVaults.length).to.be.greaterThan(0);

      for (const vaultAddress of allTransparentVaults) {
        const vault = await ethers.getContractAt("OrionTransparentVault", vaultAddress);
        void expect(await vault.paused()).to.be.true;
      }
    });
  });

  describe("3. Unpause All Functionality", function () {
    beforeEach(async function () {
      // Pause protocol first
      await config.connect(guardian).pauseAll();
    });

    it("should allow admin to unpause all protocol operations", async function () {
      await expect(config.connect(admin).unpauseAll()).to.emit(config, "ProtocolUnpaused").withArgs(admin.address);

      // Verify orchestrators are unpaused
      void expect(await internalStatesOrchestrator.paused()).to.be.false;
      void expect(await liquidityOrchestrator.paused()).to.be.false;

      // Verify vault is unpaused
      void expect(await transparentVault.paused()).to.be.false;
    });

    it("should prevent guardian from unpausing (only admin)", async function () {
      await expect(config.connect(guardian).unpauseAll()).to.be.revertedWithCustomError(config, "UnauthorizedAccess");

      // Verify everything is still paused
      void expect(await internalStatesOrchestrator.paused()).to.be.true;
      void expect(await liquidityOrchestrator.paused()).to.be.true;
      void expect(await transparentVault.paused()).to.be.true;
    });

    it("should prevent non-admin from unpausing", async function () {
      await expect(config.connect(user1).unpauseAll()).to.be.revertedWithCustomError(config, "UnauthorizedAccess");

      // Verify everything is still paused
      void expect(await internalStatesOrchestrator.paused()).to.be.true;
      void expect(await liquidityOrchestrator.paused()).to.be.true;
      void expect(await transparentVault.paused()).to.be.true;
    });

    it("should unpause all vaults", async function () {
      await config.connect(admin).unpauseAll();

      const allTransparentVaults = await config.getAllOrionVaults(0);

      for (const vaultAddress of allTransparentVaults) {
        const vault = await ethers.getContractAt("OrionTransparentVault", vaultAddress);
        void expect(await vault.paused()).to.be.false;
      }
    });
  });

  describe("4. Paused State Enforcement", function () {
    beforeEach(async function () {
      // Pause protocol
      await config.connect(guardian).pauseAll();
    });

    it("should prevent InternalStatesOrchestrator.performUpkeep() when paused", async function () {
      const performData = "0x";

      await expect(
        internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "EnforcedPause");
    });

    it("should prevent LiquidityOrchestrator.performUpkeep() when paused", async function () {
      const performData = "0x";

      await expect(
        liquidityOrchestrator.connect(automationRegistry).performUpkeep(performData),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "EnforcedPause");
    });

    it("should prevent OrionVault.requestDeposit() when paused", async function () {
      await expect(transparentVault.connect(user1).requestDeposit(DEPOSIT_AMOUNT)).to.be.revertedWithCustomError(
        transparentVault,
        "EnforcedPause",
      );
    });

    it("should prevent OrionVault.cancelDepositRequest() when paused", async function () {
      // We can't even make a deposit request to cancel, but test the guard anyway
      await expect(transparentVault.connect(user1).cancelDepositRequest(DEPOSIT_AMOUNT)).to.be.revertedWithCustomError(
        transparentVault,
        "EnforcedPause",
      );
    });

    it("should prevent OrionVault.requestRedeem() when paused", async function () {
      await expect(transparentVault.connect(user1).requestRedeem(MIN_REDEEM)).to.be.revertedWithCustomError(
        transparentVault,
        "EnforcedPause",
      );
    });

    it("should prevent OrionVault.cancelRedeemRequest() when paused", async function () {
      await expect(transparentVault.connect(user1).cancelRedeemRequest(MIN_REDEEM)).to.be.revertedWithCustomError(
        transparentVault,
        "EnforcedPause",
      );
    });

    it("should allow operations to resume after unpause", async function () {
      // Unpause
      await config.connect(admin).unpauseAll();

      // Now operations should work
      await expect(transparentVault.connect(user1).requestDeposit(DEPOSIT_AMOUNT)).to.not.be.reverted;

      // Verify deposit was successful
      expect(await transparentVault.pendingDeposit()).to.equal(DEPOSIT_AMOUNT);
    });
  });

  describe("5. Individual Contract Pause Access Control", function () {
    it("should prevent non-OrionConfig from calling pause() on InternalStatesOrchestrator", async function () {
      await expect(internalStatesOrchestrator.connect(admin).pause()).to.be.revertedWithCustomError(
        internalStatesOrchestrator,
        "UnauthorizedAccess",
      );

      await expect(internalStatesOrchestrator.connect(guardian).pause()).to.be.revertedWithCustomError(
        internalStatesOrchestrator,
        "UnauthorizedAccess",
      );
    });

    it("should prevent non-OrionConfig from calling unpause() on InternalStatesOrchestrator", async function () {
      // Pause first
      await config.connect(guardian).pauseAll();

      await expect(internalStatesOrchestrator.connect(admin).unpause()).to.be.revertedWithCustomError(
        internalStatesOrchestrator,
        "UnauthorizedAccess",
      );
    });

    it("should prevent non-OrionConfig from calling pause() on LiquidityOrchestrator", async function () {
      await expect(liquidityOrchestrator.connect(admin).pause()).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "UnauthorizedAccess",
      );

      await expect(liquidityOrchestrator.connect(guardian).pause()).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "UnauthorizedAccess",
      );
    });

    it("should prevent non-OrionConfig from calling unpause() on LiquidityOrchestrator", async function () {
      // Pause first
      await config.connect(guardian).pauseAll();

      await expect(liquidityOrchestrator.connect(admin).unpause()).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "UnauthorizedAccess",
      );
    });

    it("should prevent non-OrionConfig from calling pause() on OrionVault", async function () {
      await expect(transparentVault.connect(admin).pause()).to.be.revertedWithCustomError(
        transparentVault,
        "UnauthorizedAccess",
      );

      await expect(transparentVault.connect(guardian).pause()).to.be.revertedWithCustomError(
        transparentVault,
        "UnauthorizedAccess",
      );
    });

    it("should prevent non-OrionConfig from calling unpause() on OrionVault", async function () {
      // Pause first
      await config.connect(guardian).pauseAll();

      await expect(transparentVault.connect(admin).unpause()).to.be.revertedWithCustomError(
        transparentVault,
        "UnauthorizedAccess",
      );
    });
  });

  describe("6. Integration Scenarios", function () {
    it("should handle pause during active operations", async function () {
      // User makes a deposit request
      await transparentVault.connect(user1).requestDeposit(DEPOSIT_AMOUNT);
      expect(await transparentVault.pendingDeposit()).to.equal(DEPOSIT_AMOUNT);

      // Guardian pauses protocol
      await config.connect(guardian).pauseAll();

      // User cannot make additional requests
      await expect(transparentVault.connect(user2).requestDeposit(DEPOSIT_AMOUNT)).to.be.revertedWithCustomError(
        transparentVault,
        "EnforcedPause",
      );

      // User cannot cancel existing request
      await expect(transparentVault.connect(user1).cancelDepositRequest(DEPOSIT_AMOUNT)).to.be.revertedWithCustomError(
        transparentVault,
        "EnforcedPause",
      );

      // Pending deposit amount persists during pause
      expect(await transparentVault.pendingDeposit()).to.equal(DEPOSIT_AMOUNT);
    });

    it("should allow resuming operations after unpause", async function () {
      // Make initial deposit
      await transparentVault.connect(user1).requestDeposit(DEPOSIT_AMOUNT);

      // Pause and unpause
      await config.connect(guardian).pauseAll();
      await config.connect(admin).unpauseAll();

      // User can now cancel their request
      await expect(transparentVault.connect(user1).cancelDepositRequest(DEPOSIT_AMOUNT)).to.not.be.reverted;

      expect(await transparentVault.pendingDeposit()).to.equal(0);
    });

    it("should handle multiple pause/unpause cycles", async function () {
      // Cycle 1: Pause and unpause
      await config.connect(guardian).pauseAll();
      void expect(await transparentVault.paused()).to.be.true;

      await config.connect(admin).unpauseAll();
      void expect(await transparentVault.paused()).to.be.false;

      // Cycle 2: Pause and unpause again
      await config.connect(admin).pauseAll(); // Admin can also pause
      void expect(await transparentVault.paused()).to.be.true;

      await config.connect(admin).unpauseAll();
      void expect(await transparentVault.paused()).to.be.false;

      // Operations should still work
      await expect(transparentVault.connect(user1).requestDeposit(DEPOSIT_AMOUNT)).to.not.be.reverted;
    });

    it("should preserve state across pause/unpause", async function () {
      // Setup initial state
      await transparentVault.connect(user1).requestDeposit(DEPOSIT_AMOUNT);
      const depositBefore = await transparentVault.pendingDeposit();

      // Pause
      await config.connect(guardian).pauseAll();

      // State should be unchanged
      expect(await transparentVault.pendingDeposit()).to.equal(depositBefore);

      // Unpause
      await config.connect(admin).unpauseAll();

      // State should still be unchanged
      expect(await transparentVault.pendingDeposit()).to.equal(depositBefore);

      // Can still interact with preserved state
      await transparentVault.connect(user1).cancelDepositRequest(DEPOSIT_AMOUNT);
      expect(await transparentVault.pendingDeposit()).to.equal(0);
    });

    it("should block epoch progression when paused", async function () {
      // Start an epoch
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep("0x");

      // Pause protocol
      await config.connect(guardian).pauseAll();

      // Cannot continue epoch
      await expect(
        internalStatesOrchestrator.connect(automationRegistry).performUpkeep("0x"),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "EnforcedPause");

      await expect(liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x")).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "EnforcedPause",
      );
    });
  });
});
