import { expect } from "chai";
import { ethers } from "hardhat";
import "@openzeppelin/hardhat-upgrades";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { Signer } from "ethers";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import {
  OrionConfig,
  OrionTransparentVault,
  InternalStateOrchestrator,
  LiquidityOrchestrator,
  TransparentVaultFactory,
} from "../typechain-types";

/**
 * @title Vault Owner Removal Tests
 * @notice Tests for the automatic vault decommissioning when vault owner is removed
 * @dev This test suite validates that when a vault owner is removed from the whitelist,
 *      all vaults owned by that vault owner are automatically marked for decommissioning.
 */
describe("Vault Owner Removal - Automatic Decommissioning", function () {
  async function deployFixture() {
    const allSigners = await ethers.getSigners();
    const owner = allSigners[0];
    const manager1 = allSigners[1];
    const manager2 = allSigners[2];
    const strategist1 = allSigners[3];
    const strategist2 = allSigners[4];
    const automationRegistry = allSigners[5];

    const deployed = await deployUpgradeableProtocol(owner);

    const usdc = deployed.underlyingAsset;
    const config = deployed.orionConfig;
    const InternalStateOrchestrator: InternalStateOrchestrator = deployed.InternalStateOrchestrator;
    const liquidityOrchestrator: LiquidityOrchestrator = deployed.liquidityOrchestrator;
    const vaultFactory = deployed.transparentVaultFactory;

    await config.addWhitelistedManager(manager1.address);
    await config.addWhitelistedManager(manager2.address);

    return {
      owner,
      manager1,
      manager2,
      strategist1,
      strategist2,
      automationRegistry,
      usdc,
      config,
      vaultFactory,
      InternalStateOrchestrator,
      liquidityOrchestrator,
    };
  }

  async function createVault(
    vaultFactory: TransparentVaultFactory,
    _config: OrionConfig,
    manager: Signer,
    strategist: Signer,
    name: string,
    symbol: string,
  ): Promise<OrionTransparentVault> {
    const strategistAddress = await strategist.getAddress();
    const vaultTx = await vaultFactory.connect(manager).createVault(
      strategistAddress,
      name,
      symbol,
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
    return vaultContract as unknown as OrionTransparentVault;
  }

  describe("1. Single vault owner removal", function () {
    it("should decommission all vaults when vault owner is removed", async function () {
      const { config, vaultFactory, manager1, strategist1, strategist2 } = await loadFixture(deployFixture);

      // Create 2 vaults owned by manager1
      const vault1 = await createVault(vaultFactory, config, manager1, strategist1, "Vault 1", "V1");
      const vault2 = await createVault(vaultFactory, config, manager1, strategist2, "Vault 2", "V2");

      // Verify both vaults are active
      void expect(await config.isOrionVault(await vault1.getAddress())).to.be.true;
      void expect(await config.isOrionVault(await vault2.getAddress())).to.be.true;
      void expect(await config.isDecommissioningVault(await vault1.getAddress())).to.be.false;
      void expect(await config.isDecommissioningVault(await vault2.getAddress())).to.be.false;

      // Remove vault owner
      await config.removeWhitelistedManager(manager1.address);

      // Verify both vaults are now marked for decommissioning
      void expect(await config.isDecommissioningVault(await vault1.getAddress())).to.be.true;
      void expect(await config.isDecommissioningVault(await vault2.getAddress())).to.be.true;

      // Verify vaults are still in the active list (not yet decommissioned)
      void expect(await config.isOrionVault(await vault1.getAddress())).to.be.true;
      void expect(await config.isOrionVault(await vault2.getAddress())).to.be.true;

      // Verify vault owner is no longer whitelisted
      void expect(await config.isWhitelistedManager(manager1.address)).to.be.false;
    });

    it("should emit ManagerRemoved event", async function () {
      const { config, manager1 } = await loadFixture(deployFixture);

      // Remove vault owner and check event
      await expect(config.removeWhitelistedManager(manager1.address))
        .to.emit(config, "ManagerRemoved")
        .withArgs(manager1.address);
    });
  });

  describe("2. Multiple vault owners", function () {
    it("should only decommission vaults owned by removed vault owner", async function () {
      const { config, vaultFactory, manager1, manager2, strategist1, strategist2 } = await loadFixture(deployFixture);

      // Create vaults for both vault owners
      const vault1Owner1 = await createVault(vaultFactory, config, manager1, strategist1, "Owner1-Vault1", "O1V1");
      const vault2Owner1 = await createVault(vaultFactory, config, manager1, strategist2, "Owner1-Vault2", "O1V2");
      const vault1Owner2 = await createVault(vaultFactory, config, manager2, strategist1, "Owner2-Vault1", "O2V1");
      const vault2Owner2 = await createVault(vaultFactory, config, manager2, strategist2, "Owner2-Vault2", "O2V2");

      // Verify all vaults are active
      void expect(await config.isOrionVault(await vault1Owner1.getAddress())).to.be.true;
      void expect(await config.isOrionVault(await vault2Owner1.getAddress())).to.be.true;
      void expect(await config.isOrionVault(await vault1Owner2.getAddress())).to.be.true;
      void expect(await config.isOrionVault(await vault2Owner2.getAddress())).to.be.true;

      // Remove manager1
      await config.removeWhitelistedManager(manager1.address);

      // Verify only manager1's vaults are marked for decommissioning
      void expect(await config.isDecommissioningVault(await vault1Owner1.getAddress())).to.be.true;
      void expect(await config.isDecommissioningVault(await vault2Owner1.getAddress())).to.be.true;
      void expect(await config.isDecommissioningVault(await vault1Owner2.getAddress())).to.be.false;
      void expect(await config.isDecommissioningVault(await vault2Owner2.getAddress())).to.be.false;

      // Verify manager2's vaults are still active
      void expect(await config.isOrionVault(await vault1Owner2.getAddress())).to.be.true;
      void expect(await config.isOrionVault(await vault2Owner2.getAddress())).to.be.true;
    });
  });

  describe("3. Edge cases", function () {
    it("should handle vault owner with no vaults", async function () {
      const { config, manager1 } = await loadFixture(deployFixture);

      // Remove vault owner who has no vaults
      await expect(config.removeWhitelistedManager(manager1.address)).to.not.be.reverted;

      // Verify vault owner is removed
      void expect(await config.isWhitelistedManager(manager1.address)).to.be.false;
    });

    it("should revert if system is not idle", async function () {
      const { config, vaultFactory, manager1, strategist1, InternalStateOrchestrator, owner, usdc } =
        await loadFixture(deployFixture);

      // Create a vault with deposits to ensure processing happens
      const vault = await createVault(vaultFactory, config, manager1, strategist1, "Vault 1", "V1");

      // Make a deposit to ensure the vault is not empty
      const depositor = (await ethers.getSigners())[10];
      const depositAmount = ethers.parseUnits("1000", 6);
      await usdc.mint(depositor.address, depositAmount);
      await usdc.connect(depositor).approve(await vault.getAddress(), depositAmount);
      await vault.connect(depositor).requestDeposit(depositAmount);

      // Advance time to trigger epoch
      await ethers.provider.send("evm_increaseTime", [86400]); // 1 day
      await ethers.provider.send("evm_mine", []);

      // Start the epoch (system will not be idle)
      await InternalStateOrchestrator.connect(owner).performUpkeep("0x");

      // Verify system is not idle
      const currentPhase = await InternalStateOrchestrator.currentPhase();
      void expect(currentPhase).to.not.equal(0n);

      // Try to remove vault owner while system is not idle
      await expect(config.removeWhitelistedManager(manager1.address)).to.be.revertedWithCustomError(
        config,
        "SystemNotIdle",
      );
    });

    it("should revert if vault owner is not whitelisted", async function () {
      const { config, manager1 } = await loadFixture(deployFixture);

      // Remove vault owner first
      await config.removeWhitelistedManager(manager1.address);

      // Try to remove again
      await expect(config.removeWhitelistedManager(manager1.address)).to.be.revertedWithCustomError(
        config,
        "InvalidAddress",
      );
    });
  });

  describe("4. Intent override verification", function () {
    it("should override vault intent to 100% underlying asset on decommissioning", async function () {
      const { config, vaultFactory, manager1, strategist1 } = await loadFixture(deployFixture);

      // Create a vault
      const vault = await createVault(vaultFactory, config, manager1, strategist1, "Vault 1", "V1");

      // Check intent before decommissioning (should be 100% underlying asset by default)
      const [tokensBefore, weightsBefore] = await vault.getIntent();
      void expect(tokensBefore.length).to.equal(1);
      void expect(weightsBefore[0]).to.equal(10 ** 9); // 100% with 9 decimals

      // Remove vault owner (triggers decommissioning)
      await config.removeWhitelistedManager(manager1.address);

      // Check intent after decommissioning (should still be 100% underlying asset)
      const [tokensAfter, weightsAfter] = await vault.getIntent();
      void expect(tokensAfter.length).to.equal(1);
      void expect(weightsAfter[0]).to.equal(10 ** 9); // 100% with 9 decimals

      // Verify isDecommissioning flag is set
      void expect(await vault.isDecommissioning()).to.be.true;
    });
  });

  describe("5. Integration with vault lifecycle", function () {
    it("should allow vault to complete decommissioning after owner removal", async function () {
      const { config, vaultFactory, manager1, strategist1, liquidityOrchestrator } = await loadFixture(deployFixture);

      // Create a vault
      const vault = await createVault(vaultFactory, config, manager1, strategist1, "Vault 1", "V1");
      const vaultAddress = await vault.getAddress();

      // Remove vault owner (triggers decommissioning)
      await config.removeWhitelistedManager(manager1.address);

      // Verify vault is marked for decommissioning
      void expect(await config.isDecommissioningVault(vaultAddress)).to.be.true;
      void expect(await config.isOrionVault(vaultAddress)).to.be.true;
      void expect(await config.isDecommissionedVault(vaultAddress)).to.be.false;

      // Simulate vault decommissioning completion (normally done by LiquidityOrchestrator)
      // We need to impersonate the liquidity orchestrator
      const loAddress = await liquidityOrchestrator.getAddress();
      await ethers.provider.send("hardhat_setBalance", [loAddress, ethers.toQuantity(ethers.parseEther("1.0"))]);
      const loSigner = await ethers.getImpersonatedSigner(loAddress);

      // Complete decommissioning
      await config.connect(loSigner).completeVaultDecommissioning(vaultAddress);

      // Verify vault is now decommissioned
      void expect(await config.isDecommissioningVault(vaultAddress)).to.be.false;
      void expect(await config.isOrionVault(vaultAddress)).to.be.false;
      void expect(await config.isDecommissionedVault(vaultAddress)).to.be.true;
    });
  });

  describe("6. Security and access control", function () {
    it("should only allow owner to remove vault owner", async function () {
      const { config, manager1, manager2 } = await loadFixture(deployFixture);

      // Try to remove vault owner from non-owner account
      // Using Ownable2Step, so it will revert with OwnableUnauthorizedAccount
      await expect(config.connect(manager2).removeWhitelistedManager(manager1.address)).to.be.revertedWithCustomError(
        config,
        "OwnableUnauthorizedAccount",
      );
    });

    it("should protect against reentrancy during vault owner removal", async function () {
      const { config, vaultFactory, manager1, strategist1 } = await loadFixture(deployFixture);

      // Create multiple vaults
      await createVault(vaultFactory, config, manager1, strategist1, "Vault 1", "V1");
      await createVault(vaultFactory, config, manager1, strategist1, "Vault 2", "V2");
      await createVault(vaultFactory, config, manager1, strategist1, "Vault 3", "V3");

      // Remove vault owner - should complete without reentrancy issues
      await expect(config.removeWhitelistedManager(manager1.address)).to.not.be.reverted;
    });
  });
});
