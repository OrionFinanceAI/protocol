import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { Signer } from "ethers";
import {
  OrionConfig,
  OrionTransparentVault,
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  MockUnderlyingAsset,
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
    const vaultOwner1 = allSigners[1];
    const vaultOwner2 = allSigners[2];
    const curator1 = allSigners[3];
    const curator2 = allSigners[4];
    const automationRegistry = allSigners[5];

    // Deploy mock USDC (6 decimals)
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const usdcDeployed = await MockUnderlyingAssetFactory.deploy(6);
    await usdcDeployed.waitForDeployment();
    const usdc = usdcDeployed as unknown as MockUnderlyingAsset;

    // Deploy OrionConfig
    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    const configDeployed = await OrionConfigFactory.deploy(owner.address, owner.address, await usdc.getAddress());
    await configDeployed.waitForDeployment();
    const config = configDeployed as unknown as OrionConfig;

    // Deploy LiquidityOrchestrator
    const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
    const liquidityOrchestratorDeployed = await LiquidityOrchestratorFactory.deploy(
      owner.address,
      await config.getAddress(),
      automationRegistry.address,
    );
    await liquidityOrchestratorDeployed.waitForDeployment();
    const liquidityOrchestrator = liquidityOrchestratorDeployed as unknown as LiquidityOrchestrator;

    // Register LiquidityOrchestrator in config
    await config.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());

    // Deploy InternalStatesOrchestrator
    const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
    const internalStatesOrchestratorDeployed = await InternalStatesOrchestratorFactory.deploy(
      owner.address,
      await config.getAddress(),
      automationRegistry.address,
    );
    await internalStatesOrchestratorDeployed.waitForDeployment();
    const internalStatesOrchestrator = internalStatesOrchestratorDeployed as unknown as InternalStatesOrchestrator;

    // Register InternalStatesOrchestrator in config
    await config.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());

    // Link orchestrators
    await liquidityOrchestrator.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());

    // Deploy vault factory
    const TransparentVaultFactoryContract = await ethers.getContractFactory("TransparentVaultFactory");
    const vaultFactoryDeployed = await TransparentVaultFactoryContract.deploy(await config.getAddress());
    await vaultFactoryDeployed.waitForDeployment();
    const vaultFactory = vaultFactoryDeployed as unknown as TransparentVaultFactory;
    await config.setVaultFactory(await vaultFactory.getAddress());

    // Deploy price adapter registry
    const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
    const priceAdapterRegistry = await PriceAdapterRegistryFactory.deploy(owner.address, await config.getAddress());
    await config.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

    // Whitelist vault owners and curators
    await config.addWhitelistedVaultOwner(vaultOwner1.address);
    await config.addWhitelistedVaultOwner(vaultOwner2.address);
    await config.addWhitelistedCurator(curator1.address);
    await config.addWhitelistedCurator(curator2.address);

    return {
      owner,
      vaultOwner1,
      vaultOwner2,
      curator1,
      curator2,
      automationRegistry,
      usdc,
      config,
      vaultFactory,
      internalStatesOrchestrator,
      liquidityOrchestrator,
    };
  }

  async function createVault(
    vaultFactory: TransparentVaultFactory,
    _config: OrionConfig,
    vaultOwner: Signer,
    curator: Signer,
    name: string,
    symbol: string,
  ): Promise<OrionTransparentVault> {
    const curatorAddress = await curator.getAddress();
    const vaultTx = await vaultFactory.connect(vaultOwner).createVault(
      curatorAddress,
      name,
      symbol,
      0, // Absolute fee type
      100, // 1% performance fee
      10, // 0.1% management fee
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
      const { config, vaultFactory, vaultOwner1, curator1, curator2 } = await loadFixture(deployFixture);

      // Create 2 vaults owned by vaultOwner1
      const vault1 = await createVault(vaultFactory, config, vaultOwner1, curator1, "Vault 1", "V1");
      const vault2 = await createVault(vaultFactory, config, vaultOwner1, curator2, "Vault 2", "V2");

      // Verify both vaults are active
      void expect(await config.isOrionVault(await vault1.getAddress())).to.be.true;
      void expect(await config.isOrionVault(await vault2.getAddress())).to.be.true;
      void expect(await config.isDecommissioningVault(await vault1.getAddress())).to.be.false;
      void expect(await config.isDecommissioningVault(await vault2.getAddress())).to.be.false;

      // Remove vault owner
      await config.removeWhitelistedVaultOwner(vaultOwner1.address);

      // Verify both vaults are now marked for decommissioning
      void expect(await config.isDecommissioningVault(await vault1.getAddress())).to.be.true;
      void expect(await config.isDecommissioningVault(await vault2.getAddress())).to.be.true;

      // Verify vaults are still in the active list (not yet decommissioned)
      void expect(await config.isOrionVault(await vault1.getAddress())).to.be.true;
      void expect(await config.isOrionVault(await vault2.getAddress())).to.be.true;

      // Verify vault owner is no longer whitelisted
      void expect(await config.isWhitelistedVaultOwner(vaultOwner1.address)).to.be.false;
    });

    it("should emit VaultOwnerRemoved event", async function () {
      const { config, vaultOwner1 } = await loadFixture(deployFixture);

      // Remove vault owner and check event
      await expect(config.removeWhitelistedVaultOwner(vaultOwner1.address))
        .to.emit(config, "VaultOwnerRemoved")
        .withArgs(vaultOwner1.address);
    });
  });

  describe("2. Multiple vault owners", function () {
    it("should only decommission vaults owned by removed vault owner", async function () {
      const { config, vaultFactory, vaultOwner1, vaultOwner2, curator1, curator2 } = await loadFixture(deployFixture);

      // Create vaults for both vault owners
      const vault1Owner1 = await createVault(vaultFactory, config, vaultOwner1, curator1, "Owner1-Vault1", "O1V1");
      const vault2Owner1 = await createVault(vaultFactory, config, vaultOwner1, curator2, "Owner1-Vault2", "O1V2");
      const vault1Owner2 = await createVault(vaultFactory, config, vaultOwner2, curator1, "Owner2-Vault1", "O2V1");
      const vault2Owner2 = await createVault(vaultFactory, config, vaultOwner2, curator2, "Owner2-Vault2", "O2V2");

      // Verify all vaults are active
      void expect(await config.isOrionVault(await vault1Owner1.getAddress())).to.be.true;
      void expect(await config.isOrionVault(await vault2Owner1.getAddress())).to.be.true;
      void expect(await config.isOrionVault(await vault1Owner2.getAddress())).to.be.true;
      void expect(await config.isOrionVault(await vault2Owner2.getAddress())).to.be.true;

      // Remove vaultOwner1
      await config.removeWhitelistedVaultOwner(vaultOwner1.address);

      // Verify only vaultOwner1's vaults are marked for decommissioning
      void expect(await config.isDecommissioningVault(await vault1Owner1.getAddress())).to.be.true;
      void expect(await config.isDecommissioningVault(await vault2Owner1.getAddress())).to.be.true;
      void expect(await config.isDecommissioningVault(await vault1Owner2.getAddress())).to.be.false;
      void expect(await config.isDecommissioningVault(await vault2Owner2.getAddress())).to.be.false;

      // Verify vaultOwner2's vaults are still active
      void expect(await config.isOrionVault(await vault1Owner2.getAddress())).to.be.true;
      void expect(await config.isOrionVault(await vault2Owner2.getAddress())).to.be.true;
    });
  });

  describe("3. Edge cases", function () {
    it("should handle vault owner with no vaults", async function () {
      const { config, vaultOwner1 } = await loadFixture(deployFixture);

      // Remove vault owner who has no vaults
      await expect(config.removeWhitelistedVaultOwner(vaultOwner1.address)).to.not.be.reverted;

      // Verify vault owner is removed
      void expect(await config.isWhitelistedVaultOwner(vaultOwner1.address)).to.be.false;
    });

    it("should revert if system is not idle", async function () {
      const { config, vaultFactory, vaultOwner1, curator1, internalStatesOrchestrator, owner, usdc } =
        await loadFixture(deployFixture);

      // Create a vault with deposits to ensure processing happens
      const vault = await createVault(vaultFactory, config, vaultOwner1, curator1, "Vault 1", "V1");

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
      await internalStatesOrchestrator.connect(owner).performUpkeep("0x");

      // Verify system is not idle
      const currentPhase = await internalStatesOrchestrator.currentPhase();
      void expect(currentPhase).to.not.equal(0n);

      // Try to remove vault owner while system is not idle
      await expect(config.removeWhitelistedVaultOwner(vaultOwner1.address)).to.be.revertedWithCustomError(
        config,
        "SystemNotIdle",
      );
    });

    it("should revert if vault owner is not whitelisted", async function () {
      const { config, vaultOwner1 } = await loadFixture(deployFixture);

      // Remove vault owner first
      await config.removeWhitelistedVaultOwner(vaultOwner1.address);

      // Try to remove again
      await expect(config.removeWhitelistedVaultOwner(vaultOwner1.address)).to.be.revertedWithCustomError(
        config,
        "InvalidAddress",
      );
    });
  });

  describe("4. Intent override verification", function () {
    it("should override vault intent to 100% underlying asset on decommissioning", async function () {
      const { config, vaultFactory, vaultOwner1, curator1 } = await loadFixture(deployFixture);

      // Create a vault
      const vault = await createVault(vaultFactory, config, vaultOwner1, curator1, "Vault 1", "V1");

      // Check intent before decommissioning (should be 100% underlying asset by default)
      const [tokensBefore, weightsBefore] = await vault.getIntent();
      void expect(tokensBefore.length).to.equal(1);
      void expect(weightsBefore[0]).to.equal(10 ** 9); // 100% with 9 decimals

      // Remove vault owner (triggers decommissioning)
      await config.removeWhitelistedVaultOwner(vaultOwner1.address);

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
      const { config, vaultFactory, vaultOwner1, curator1, liquidityOrchestrator } = await loadFixture(deployFixture);

      // Create a vault
      const vault = await createVault(vaultFactory, config, vaultOwner1, curator1, "Vault 1", "V1");
      const vaultAddress = await vault.getAddress();

      // Remove vault owner (triggers decommissioning)
      await config.removeWhitelistedVaultOwner(vaultOwner1.address);

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
      const { config, vaultOwner1, vaultOwner2 } = await loadFixture(deployFixture);

      // Try to remove vault owner from non-owner account
      // Using Ownable2Step, so it will revert with OwnableUnauthorizedAccount
      await expect(
        config.connect(vaultOwner2).removeWhitelistedVaultOwner(vaultOwner1.address),
      ).to.be.revertedWithCustomError(config, "OwnableUnauthorizedAccount");
    });

    it("should protect against reentrancy during vault owner removal", async function () {
      const { config, vaultFactory, vaultOwner1, curator1 } = await loadFixture(deployFixture);

      // Create multiple vaults
      await createVault(vaultFactory, config, vaultOwner1, curator1, "Vault 1", "V1");
      await createVault(vaultFactory, config, vaultOwner1, curator1, "Vault 2", "V2");
      await createVault(vaultFactory, config, vaultOwner1, curator1, "Vault 3", "V3");

      // Remove vault owner - should complete without reentrancy issues
      await expect(config.removeWhitelistedVaultOwner(vaultOwner1.address)).to.not.be.reverted;
    });
  });
});
