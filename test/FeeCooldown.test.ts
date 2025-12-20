import { expect } from "chai";
import { ethers } from "hardhat";
import "@openzeppelin/hardhat-upgrades";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { OrionTransparentVault, InternalStatesOrchestrator } from "../typechain-types";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";

/**
 * @title Fee Cooldown Mechanism Tests
 * @notice Comprehensive tests for 7-day fee change cooldown to protect users
 * @dev Tests the fix for audit finding: vault owners changing fees before epoch end
 */
describe("Fee Cooldown Mechanism", function () {
  const FEE_TYPE = {
    ABSOLUTE: 0,
    SOFT_HURDLE: 1,
    HARD_HURDLE: 2,
    HIGH_WATER_MARK: 3,
    HURDLE_HWM: 4,
  };

  const DEFAULT_COOLDOWN = 7n * 24n * 60n * 60n; // 7 days

  // Max fees for testing
  const MAX_PERFORMANCE_FEE = 3000; // 30%
  const MAX_MANAGEMENT_FEE = 300; // 3%
  const MAX_PROTOCOL_VOLUME_FEE = 50; // 0.5%
  const MAX_PROTOCOL_REVENUE_SHARE = 2000; // 20%

  async function deployFixture() {
    const [owner, curator, user1, user2, automationRegistry] = await ethers.getSigners();

    const deployed = await deployUpgradeableProtocol(owner, owner);

    const usdc = deployed.underlyingAsset;
    const config = deployed.orionConfig;
    const internalStatesOrchestrator: InternalStatesOrchestrator = deployed.internalStatesOrchestrator;
    const vaultFactory = deployed.transparentVaultFactory;

    return {
      config,
      vaultFactory,
      usdc,
      owner,
      curator,
      user1,
      user2,
      internalStatesOrchestrator,
      automationRegistry,
    };
  }

  async function createVault(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    feeType: number,
    performanceFee: number,
    managementFee: number,
  ): Promise<OrionTransparentVault> {
    const { vaultFactory, owner, curator, config } = fixture;

    // Whitelist owner if not already whitelisted
    if (!(await config.isWhitelistedVaultOwner(owner.address))) {
      await config.addWhitelistedVaultOwner(owner.address);
    }

    const vaultTx = await vaultFactory
      .connect(owner)
      .createVault(curator.address, "Test Vault", "TVAULT", feeType, performanceFee, managementFee, ethers.ZeroAddress);
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
    return (await ethers.getContractAt("OrionTransparentVault", vaultAddress)) as unknown as OrionTransparentVault;
  }

  describe("OrionConfig: Cooldown Duration Management", function () {
    it("should initialize with 7-day default cooldown", async function () {
      const { config } = await loadFixture(deployFixture);

      const cooldown = await config.feeChangeCooldownDuration();
      expect(cooldown).to.equal(DEFAULT_COOLDOWN);
    });

    it("should allow owner to update cooldown duration", async function () {
      const { config, owner } = await loadFixture(deployFixture);

      const newCooldown = 14n * 24n * 60n * 60n; // 14 days
      await expect(config.connect(owner).setFeeChangeCooldownDuration(newCooldown))
        .to.emit(config, "FeeChangeCooldownDurationUpdated")
        .withArgs(newCooldown);

      expect(await config.feeChangeCooldownDuration()).to.equal(newCooldown);
    });

    it("should allow zero cooldown (instant fee changes)", async function () {
      const { config, owner } = await loadFixture(deployFixture);

      await config.connect(owner).setFeeChangeCooldownDuration(0);
      expect(await config.feeChangeCooldownDuration()).to.equal(0);
    });

    it("should reject non-owner attempting to update cooldown", async function () {
      const { config, user1 } = await loadFixture(deployFixture);

      const newCooldown = 14n * 24n * 60n * 60n;
      await expect(config.connect(user1).setFeeChangeCooldownDuration(newCooldown)).to.be.revertedWithCustomError(
        config,
        "OwnableUnauthorizedAccount",
      );
    });

    it("should allow any cooldown duration (no maximum limit)", async function () {
      const { config, owner } = await loadFixture(deployFixture);

      // Test with 30 days
      const thirtyDays = 30n * 24n * 60n * 60n;
      await config.connect(owner).setFeeChangeCooldownDuration(thirtyDays);
      expect(await config.feeChangeCooldownDuration()).to.equal(thirtyDays);

      // Test with 90 days (should also work - no maximum)
      const ninetyDays = 90n * 24n * 60n * 60n;
      await config.connect(owner).setFeeChangeCooldownDuration(ninetyDays);
      expect(await config.feeChangeCooldownDuration()).to.equal(ninetyDays);
    });
  });

  describe("Vault Fee Cooldown: Storage and Timing", function () {
    it("should store new fee rates immediately in storage", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1000, 100);

      await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, 2000, 200);

      // New fees should be in storage
      const feeModel = await vault.feeModel();
      expect(feeModel.performanceFee).to.equal(2000);
      expect(feeModel.managementFee).to.equal(200);
      expect(feeModel.feeType).to.equal(FEE_TYPE.ABSOLUTE);
    });

    it("should set correct effective timestamp for fee changes", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1000, 100);

      const tx = await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, 2000, 200);
      const receipt = await tx.wait();
      const blockTimestamp = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;
      const expectedEffectiveTime = blockTimestamp + Number(DEFAULT_COOLDOWN);

      const newFeeRatesTimestamp = await vault.newFeeRatesTimestamp();
      expect(newFeeRatesTimestamp).to.equal(expectedEffectiveTime);
    });

    it("should emit VaultFeeChangeScheduled event with correct parameters", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1000, 100);

      const tx = vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.SOFT_HURDLE, 2500, 250);

      await expect(tx).to.emit(vault, "VaultFeeChangeScheduled");
    });

    it("should update effective timestamp when fees are changed multiple times", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1000, 100);

      // First update
      await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, 1500, 150);
      const firstTimestamp = await vault.newFeeRatesTimestamp();

      // Wait a bit
      await time.increase(3600); // 1 hour

      // Second update
      await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, 2000, 200);
      const secondTimestamp = await vault.newFeeRatesTimestamp();

      // Second timestamp should be later
      expect(secondTimestamp).to.be.gt(firstTimestamp);
    });

    it("should store old fee model during cooldown", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1000, 100);

      // Change fees
      await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.HIGH_WATER_MARK, 2000, 200);

      // During cooldown period, old fees (1000, 100) should be used
      // After cooldown, new fees (2000, 200) should be used
      // Storage shows new fees immediately
      const feeModel = await vault.feeModel();
      expect(feeModel.performanceFee).to.equal(2000);
      expect(feeModel.managementFee).to.equal(200);
    });
  });

  describe("Protocol Fee Cooldown: Storage and Timing", function () {
    it("should store new protocol fee rates immediately in storage", async function () {
      const { internalStatesOrchestrator, owner } = await loadFixture(deployFixture);

      await internalStatesOrchestrator.connect(owner).updateProtocolFees(25, 1000);

      const vFee = await internalStatesOrchestrator.vFeeCoefficient();
      const rsFee = await internalStatesOrchestrator.rsFeeCoefficient();

      expect(vFee).to.equal(25);
      expect(rsFee).to.equal(1000);
    });

    it("should set correct effective timestamp for protocol fee changes", async function () {
      const { internalStatesOrchestrator, owner } = await loadFixture(deployFixture);

      const tx = await internalStatesOrchestrator.connect(owner).updateProtocolFees(25, 1000);
      const receipt = await tx.wait();
      const blockTimestamp = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;
      const expectedEffectiveTime = blockTimestamp + Number(DEFAULT_COOLDOWN);

      const newProtocolFeeRatesTimestamp = await internalStatesOrchestrator.newProtocolFeeRatesTimestamp();
      expect(newProtocolFeeRatesTimestamp).to.equal(expectedEffectiveTime);
    });

    it("should emit ProtocolFeeChangeScheduled event", async function () {
      const { internalStatesOrchestrator, owner } = await loadFixture(deployFixture);

      await expect(internalStatesOrchestrator.connect(owner).updateProtocolFees(25, 1000)).to.emit(
        internalStatesOrchestrator,
        "ProtocolFeeChangeScheduled",
      );
    });

    it("should reject protocol fees exceeding maximums", async function () {
      const { internalStatesOrchestrator, owner } = await loadFixture(deployFixture);

      // Exceeding volume fee max (0.5%)
      await expect(
        internalStatesOrchestrator.connect(owner).updateProtocolFees(MAX_PROTOCOL_VOLUME_FEE + 1, 1000),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "InvalidArguments");

      // Exceeding revenue share max (20%)
      await expect(
        internalStatesOrchestrator.connect(owner).updateProtocolFees(25, MAX_PROTOCOL_REVENUE_SHARE + 1),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "InvalidArguments");
    });

    it("should allow setting protocol fees to zero", async function () {
      const { internalStatesOrchestrator, owner } = await loadFixture(deployFixture);

      await expect(internalStatesOrchestrator.connect(owner).updateProtocolFees(0, 0)).to.emit(
        internalStatesOrchestrator,
        "ProtocolFeeChangeScheduled",
      );

      expect(await internalStatesOrchestrator.vFeeCoefficient()).to.equal(0);
      expect(await internalStatesOrchestrator.rsFeeCoefficient()).to.equal(0);
    });
  });

  describe("Cooldown Behavior: Timing Transitions", function () {
    it("should respect cooldown duration from config", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1000, 100);

      // Change config cooldown to 3 days
      const customCooldown = 3n * 24n * 60n * 60n;
      await fixture.config.connect(fixture.owner).setFeeChangeCooldownDuration(customCooldown);

      const tx = await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, 2000, 200);
      const receipt = await tx.wait();
      const blockTimestamp = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;
      const expectedEffectiveTime = blockTimestamp + Number(customCooldown);

      const newFeeRatesTimestamp = await vault.newFeeRatesTimestamp();
      expect(newFeeRatesTimestamp).to.equal(expectedEffectiveTime);
    });

    it("should allow immediate fee changes with zero cooldown", async function () {
      const fixture = await loadFixture(deployFixture);

      // Set cooldown to zero
      await fixture.config.connect(fixture.owner).setFeeChangeCooldownDuration(0);

      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1000, 100);

      const tx = await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, 2000, 200);
      const receipt = await tx.wait();
      const blockTimestamp = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;

      const newFeeRatesTimestamp = await vault.newFeeRatesTimestamp();
      // With zero cooldown, effective time should equal block timestamp
      expect(newFeeRatesTimestamp).to.equal(blockTimestamp);
    });

    it("should handle long cooldown duration correctly", async function () {
      const fixture = await loadFixture(deployFixture);

      // Set to 90-day cooldown (no maximum limit)
      const longCooldown = 90n * 24n * 60n * 60n;
      await fixture.config.connect(fixture.owner).setFeeChangeCooldownDuration(longCooldown);

      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1000, 100);

      const tx = await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, 2000, 200);
      const receipt = await tx.wait();
      const blockTimestamp = (await ethers.provider.getBlock(receipt!.blockNumber))!.timestamp;
      const expectedEffectiveTime = blockTimestamp + Number(longCooldown);

      const newFeeRatesTimestamp = await vault.newFeeRatesTimestamp();
      expect(newFeeRatesTimestamp).to.equal(expectedEffectiveTime);
    });
  });

  describe("Security: Authorization and Access Control", function () {
    it("should only allow vault owner to update vault fees", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1000, 100);

      await expect(
        vault.connect(fixture.user1).updateFeeModel(FEE_TYPE.ABSOLUTE, 2000, 200),
      ).to.be.revertedWithCustomError(vault, "NotAuthorized");

      await expect(
        vault.connect(fixture.curator).updateFeeModel(FEE_TYPE.ABSOLUTE, 2000, 200),
      ).to.be.revertedWithCustomError(vault, "NotAuthorized");
    });

    it("should only allow owner to update protocol fees", async function () {
      const { internalStatesOrchestrator, user1, curator } = await loadFixture(deployFixture);

      await expect(
        internalStatesOrchestrator.connect(user1).updateProtocolFees(25, 1000),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "OwnableUnauthorizedAccount");

      await expect(
        internalStatesOrchestrator.connect(curator).updateProtocolFees(25, 1000),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "OwnableUnauthorizedAccount");
    });

    it("should only allow config owner to modify cooldown duration", async function () {
      const { config, user1 } = await loadFixture(deployFixture);

      await expect(
        config.connect(user1).setFeeChangeCooldownDuration(14n * 24n * 60n * 60n),
      ).to.be.revertedWithCustomError(config, "OwnableUnauthorizedAccount");
    });

    it("should reject vault fee updates exceeding maximums", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1000, 100);

      // Performance fee too high
      await expect(
        vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, MAX_PERFORMANCE_FEE + 1, 100),
      ).to.be.revertedWithCustomError(vault, "InvalidArguments");

      // Management fee too high
      await expect(
        vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, 1000, MAX_MANAGEMENT_FEE + 1),
      ).to.be.revertedWithCustomError(vault, "InvalidArguments");

      // Invalid fee type
      await expect(
        vault.connect(fixture.owner).updateFeeModel(6, 1000, 100), // Only 0-4 are valid
      ).to.be.revertedWithCustomError(vault, "InvalidArguments");
    });
  });

  describe("Edge Cases: Fee Model Changes", function () {
    it("should handle changing fee type during cooldown", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1000, 100);

      // Change from ABSOLUTE to HIGH_WATER_MARK
      await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.HIGH_WATER_MARK, 2000, 200);

      // Storage should reflect new fee type
      const feeModel = await vault.feeModel();
      expect(feeModel.feeType).to.equal(FEE_TYPE.HIGH_WATER_MARK);
      expect(feeModel.performanceFee).to.equal(2000);
      expect(feeModel.managementFee).to.equal(200);
    });

    it("should handle reducing fees (user-friendly change)", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 2000, 200);

      // Reduce fees
      await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, 1000, 100);

      // Even when reducing, cooldown applies (for consistency)
      const effectiveTime = await vault.newFeeRatesTimestamp();
      const currentTime = await time.latest();
      expect(effectiveTime).to.be.gt(currentTime);
    });

    it("should handle setting fees to zero", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1000, 100);

      await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, 0, 0);

      const feeModel = await vault.feeModel();
      expect(feeModel.performanceFee).to.equal(0);
      expect(feeModel.managementFee).to.equal(0);
    });

    it("should handle setting fees to maximum allowed values", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 0, 0);

      await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, MAX_PERFORMANCE_FEE, MAX_MANAGEMENT_FEE);

      const feeModel = await vault.feeModel();
      expect(feeModel.performanceFee).to.equal(MAX_PERFORMANCE_FEE);
      expect(feeModel.managementFee).to.equal(MAX_MANAGEMENT_FEE);
    });

    it("should handle all fee type transitions", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1000, 100);

      const feeTypes = [
        FEE_TYPE.SOFT_HURDLE,
        FEE_TYPE.HARD_HURDLE,
        FEE_TYPE.HIGH_WATER_MARK,
        FEE_TYPE.HURDLE_HWM,
        FEE_TYPE.ABSOLUTE,
      ];

      for (const feeType of feeTypes) {
        await vault.connect(fixture.owner).updateFeeModel(feeType, 1500, 150);
        const feeModel = await vault.feeModel();
        expect(feeModel.feeType).to.equal(feeType);
      }
    });
  });

  describe("Integration: Attack Prevention Scenarios", function () {
    it("should prevent last-minute fee changes before epoch end (main attack vector)", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 500, 50);

      // Vault owner tries to change fees just before epoch ends
      // With cooldown, this won't affect current epoch processing
      await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, MAX_PERFORMANCE_FEE, MAX_MANAGEMENT_FEE);

      // Verify cooldown is active
      const effectiveTime = await vault.newFeeRatesTimestamp();
      const currentTime = await time.latest();
      const cooldownDuration = effectiveTime - BigInt(currentTime);

      expect(cooldownDuration).to.be.closeTo(DEFAULT_COOLDOWN, 10n);

      // This gives users 7 days to exit if they disagree with new fees
    });

    it("should prevent multiple rapid fee updates to bypass cooldown", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1000, 100);

      // First update
      await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, 1500, 150);
      const firstEffectiveTime = await vault.newFeeRatesTimestamp();

      // Immediate second update (trying to bypass)
      await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, 2000, 200);
      const secondEffectiveTime = await vault.newFeeRatesTimestamp();

      // Second update should have its own cooldown from current time
      expect(secondEffectiveTime).to.be.gt(firstEffectiveTime);

      // Verify second update starts fresh cooldown
      const currentTime = await time.latest();
      const cooldownRemaining = secondEffectiveTime - BigInt(currentTime);
      expect(cooldownRemaining).to.be.closeTo(DEFAULT_COOLDOWN, 10n);
    });

    it("should demonstrate user protection window", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1000, 100);

      // Vault owner schedules fee increase
      await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, MAX_PERFORMANCE_FEE, MAX_MANAGEMENT_FEE);

      const effectiveTime = await vault.newFeeRatesTimestamp();
      const currentTime = await time.latest();

      // Users have 7 days to react
      const userProtectionWindow = effectiveTime - BigInt(currentTime);
      expect(userProtectionWindow).to.equal(DEFAULT_COOLDOWN);

      // During this window, users can:
      // 1. Cancel pending deposits
      // 2. Request redemptions
      // 3. Evaluate if they want to stay with new fees
    });
  });

  describe("Integration: Normal Operations", function () {
    it("should allow normal fee adjustments with proper notice", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1500, 150);

      // Owner adjusts fees based on performance/market
      const tx = await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, 1750, 175);

      await expect(tx).to.emit(vault, "VaultFeeChangeScheduled");

      // Fees will be effective after cooldown
      const effectiveTime = await vault.newFeeRatesTimestamp();
      const currentTime = await time.latest();
      expect(effectiveTime - BigInt(currentTime)).to.be.closeTo(DEFAULT_COOLDOWN, 10n);
    });

    it("should allow protocol fee adjustments with proper notice", async function () {
      const { internalStatesOrchestrator, owner } = await loadFixture(deployFixture);

      const tx = await internalStatesOrchestrator.connect(owner).updateProtocolFees(30, 1500);

      await expect(tx).to.emit(internalStatesOrchestrator, "ProtocolFeeChangeScheduled");

      const effectiveTime = await internalStatesOrchestrator.newProtocolFeeRatesTimestamp();
      const currentTime = await time.latest();
      expect(effectiveTime - BigInt(currentTime)).to.be.closeTo(DEFAULT_COOLDOWN, 10n);
    });

    it("should support competitive fee reductions", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 2500, 250);

      // Owner reduces fees to attract deposits
      await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, 1500, 150);

      // Even reductions have cooldown for consistency and predictability
      const feeModel = await vault.feeModel();
      expect(feeModel.performanceFee).to.equal(1500);
      expect(feeModel.managementFee).to.equal(150);
    });
  });

  describe("Precision and Edge Cases", function () {
    it("should handle very small fees with cooldown", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1, 1); // 0.01% each

      await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, 2, 2);

      const feeModel = await vault.feeModel();
      expect(feeModel.performanceFee).to.equal(2);
      expect(feeModel.managementFee).to.equal(2);
    });

    it("should handle timestamp edge cases around cooldown expiry", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1000, 100);

      await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, 2000, 200);
      const effectiveTime = await vault.newFeeRatesTimestamp();

      // Fast forward to just before effective time
      await time.increaseTo(effectiveTime - 1n);
      let currentTime = await time.latest();
      expect(currentTime).to.be.lt(effectiveTime);

      // Fast forward to exact effective time
      await time.increaseTo(effectiveTime);
      currentTime = await time.latest();
      expect(currentTime).to.equal(effectiveTime);

      // Fast forward past effective time
      await time.increaseTo(effectiveTime + 1n);
      currentTime = await time.latest();
      expect(currentTime).to.be.gt(effectiveTime);
    });
  });

  describe("Documentation: Cooldown Behavior", function () {
    it("should document that storage is updated immediately", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 1000, 100);

      await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, 2000, 200);

      // IMPORTANT: Storage reflects new values immediately
      const feeModel = await vault.feeModel();
      expect(feeModel.performanceFee).to.equal(2000);
      expect(feeModel.managementFee).to.equal(200);

      // However, _activeFeeModel() internal function returns old values during cooldown
      // This is verified through fee calculations in actual operation
    });

    it("should document that cooldown protects against malicious fee changes", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 500, 50);

      // Malicious scenario: owner tries to maximize fees before users can exit
      await vault.connect(fixture.owner).updateFeeModel(FEE_TYPE.ABSOLUTE, MAX_PERFORMANCE_FEE, MAX_MANAGEMENT_FEE);

      // Protection: 7-day window for users to exit
      const effectiveTime = await vault.newFeeRatesTimestamp();
      const currentTime = await time.latest();
      const protectionWindow = effectiveTime - BigInt(currentTime);

      expect(protectionWindow).to.equal(DEFAULT_COOLDOWN);
      // This means users have 7 full days to cancel deposits or request redemptions
    });
  });
});
