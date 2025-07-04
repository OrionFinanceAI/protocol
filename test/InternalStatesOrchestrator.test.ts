import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("InternalStatesOrchestrator", function () {
  // Test fixture setup
  async function deployOrchestratorFixture(): Promise<{
    orchestrator: any;
    orionConfig: any;
    oracleRegistry: any;
    underlyingAsset: any;
    owner: any;
    automationRegistry: any;
    liquidityOrchestrator: any;
    vaultFactory: any;
    curator1: any;
    curator2: any;
    unauthorized: any;
    vault1: any;
    vault2: any;
    encryptedVault: any;
  }> {
    const [
      owner,
      automationRegistry,
      _configSigner,
      _oracleRegistry,
      liquidityOrchestrator,
      vaultFactory,
      curator1,
      curator2,
      unauthorized,
    ] = await ethers.getSigners();

    // Deploy mock underlying asset
    const UnderlyingAssetFactory = await ethers.getContractFactory("UnderlyingAsset");
    const underlyingAsset = (await UnderlyingAssetFactory.deploy()) as UnderlyingAsset;
    await underlyingAsset.waitForDeployment();
    const underlyingAssetAddress = await underlyingAsset.getAddress();

    // Deploy OrionConfig
    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    const config = (await OrionConfigFactory.deploy()) as OrionConfig;
    await config.waitForDeployment();
    const configAddress = await config.getAddress();
    await config.initialize(owner.address);

    // Deploy OracleRegistry
    const OracleRegistryFactory = await ethers.getContractFactory("OracleRegistry");
    const oracleRegistryContract = await OracleRegistryFactory.deploy();
    await oracleRegistryContract.waitForDeployment();
    const oracleRegistryAddress = await oracleRegistryContract.getAddress();

    // Deploy InternalStatesOrchestrator
    const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
    const orchestrator = await InternalStatesOrchestratorFactory.deploy();
    await orchestrator.waitForDeployment();
    await orchestrator.initialize(owner.address, automationRegistry.address, configAddress);
    const orchestratorAddress = await orchestrator.getAddress();

    // Set protocol parameters in OrionConfig
    await config.setProtocolParams(
      underlyingAssetAddress,
      orchestratorAddress,
      liquidityOrchestrator.address,
      18, // statesDecimals
      6, // curatorIntentDecimals
      vaultFactory.address, // factory
      oracleRegistryAddress, // oracleRegistry
    );

    // Deploy mock transparent vaults
    const OrionTransparentVaultFactory = await ethers.getContractFactory("OrionTransparentVault");
    const vault1 = (await OrionTransparentVaultFactory.deploy()) as OrionTransparentVault;
    await vault1.waitForDeployment();
    await vault1.initialize(curator1.address, configAddress, "Test Vault 1", "TV1");

    const vault2 = (await OrionTransparentVaultFactory.deploy()) as OrionTransparentVault;
    await vault2.waitForDeployment();
    await vault2.initialize(curator2.address, configAddress, "Test Vault 2", "TV2");

    // Add vaults to config
    await config.connect(vaultFactory).addOrionVault(await vault1.getAddress(), 1); // Transparent
    await config.connect(vaultFactory).addOrionVault(await vault2.getAddress(), 1); // Transparent

    // Deploy mock encrypted vault
    const OrionEncryptedVaultFactory = await ethers.getContractFactory("OrionEncryptedVault");
    const encryptedVault = await OrionEncryptedVaultFactory.deploy();
    await encryptedVault.waitForDeployment();
    await encryptedVault.initialize(curator1.address, configAddress, "Encrypted Vault", "EV");

    // Add encrypted vault to config
    await config.connect(vaultFactory).addOrionVault(await encryptedVault.getAddress(), 0); // Encrypted

    return {
      orchestrator,
      orionConfig: config,
      oracleRegistry: oracleRegistryContract,
      underlyingAsset,
      owner,
      automationRegistry,
      liquidityOrchestrator,
      vaultFactory,
      curator1,
      curator2,
      unauthorized,
      vault1,
      vault2,
      encryptedVault,
    };
  }

  describe("Initialization", function () {
    it("Should initialize with correct parameters", async function () {
      const { orchestrator, owner, automationRegistry, orionConfig } = await loadFixture(deployOrchestratorFixture);
      expect(await orchestrator.owner()).to.equal(owner.address);
      expect(await orchestrator.automationRegistry()).to.equal(automationRegistry.address);
      expect(await orchestrator.config()).to.equal(await orionConfig.getAddress());
      expect(await orchestrator.epochCounter()).to.equal(0);
    });

    it("Should revert if initialized with zero automation registry", async function () {
      const { orionConfig, owner } = await loadFixture(deployOrchestratorFixture);
      const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
      const orchestrator = await InternalStatesOrchestratorFactory.deploy();
      await orchestrator.waitForDeployment();

      await expect(
        orchestrator.initialize(owner.address, ethers.ZeroAddress, await orionConfig.getAddress()),
      ).to.be.revertedWithCustomError(orchestrator, "ZeroAddress");
    });
  });

  describe("Access Control", function () {
    it("Should only allow owner to update automation registry", async function () {
      const { orchestrator, unauthorized } = await loadFixture(deployOrchestratorFixture);
      await expect(
        orchestrator.connect(unauthorized).updateAutomationRegistry(unauthorized.address),
      ).to.be.revertedWithCustomError(orchestrator, "OwnableUnauthorizedAccount");
    });

    it("Should only allow owner to update config", async function () {
      const { orchestrator, unauthorized } = await loadFixture(deployOrchestratorFixture);
      await expect(orchestrator.connect(unauthorized).updateConfig(unauthorized.address)).to.be.revertedWithCustomError(
        orchestrator,
        "OwnableUnauthorizedAccount",
      );
    });

    it("Should only allow automation registry to call performUpkeep", async function () {
      const { orchestrator, unauthorized } = await loadFixture(deployOrchestratorFixture);
      await expect(orchestrator.connect(unauthorized).performUpkeep("0x")).to.be.revertedWithCustomError(
        orchestrator,
        "NotAuthorized",
      );
    });
  });

  describe("Configuration Updates", function () {
    it("Should update automation registry correctly", async function () {
      const { orchestrator, unauthorized } = await loadFixture(deployOrchestratorFixture);
      await expect(orchestrator.updateAutomationRegistry(unauthorized.address))
        .to.emit(orchestrator, "AutomationRegistryUpdated")
        .withArgs(unauthorized.address);
      expect(await orchestrator.automationRegistry()).to.equal(unauthorized.address);
    });

    it("Should revert updating automation registry to zero address", async function () {
      const { orchestrator } = await loadFixture(deployOrchestratorFixture);
      await expect(orchestrator.updateAutomationRegistry(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        orchestrator,
        "ZeroAddress",
      );
    });

    it("Should update config correctly", async function () {
      const { orchestrator, unauthorized } = await loadFixture(deployOrchestratorFixture);
      await orchestrator.updateConfig(unauthorized.address);
      expect(await orchestrator.config()).to.equal(unauthorized.address);
    });
  });

  describe("checkUpkeep", function () {
    it("Should return false when not enough time has passed", async function () {
      const { orchestrator } = await loadFixture(deployOrchestratorFixture);
      const [upkeepNeeded, performData] = await orchestrator.checkUpkeep("0x");
      expect(upkeepNeeded).to.be.false;
      expect(performData).to.equal("0x");
    });

    it("Should return true when enough time has passed", async function () {
      const { orchestrator } = await loadFixture(deployOrchestratorFixture);

      await ethers.provider.send("evm_increaseTime", [1e18]);
      await ethers.provider.send("evm_mine", []);

      const [upkeepNeeded, performData] = await orchestrator.checkUpkeep("0x");
      expect(upkeepNeeded).to.be.true;
      expect(performData).to.equal("0x");
    });
  });

  describe("performUpkeep", function () {
    it("Should revert if called too early", async function () {
      const { orchestrator, automationRegistry } = await loadFixture(deployOrchestratorFixture);
      await expect(orchestrator.connect(automationRegistry).performUpkeep("0x")).to.be.revertedWithCustomError(
        orchestrator,
        "TooEarly",
      );
    });

    it("Should process upkeep when enough time has passed", async function () {
      const { orchestrator, automationRegistry } = await loadFixture(deployOrchestratorFixture);

      await ethers.provider.send("evm_increaseTime", [1e18]);
      await ethers.provider.send("evm_mine", []);

      const epochCounterBefore = await orchestrator.epochCounter();
      const nextUpdateTimeBefore = await orchestrator.nextUpdateTime();

      await expect(orchestrator.connect(automationRegistry).performUpkeep("0x"))
        .to.emit(orchestrator, "InternalStateProcessed")
        .withArgs(epochCounterBefore + 1n);

      expect(await orchestrator.epochCounter()).to.equal(epochCounterBefore + 1n);
      expect(await orchestrator.nextUpdateTime()).to.be.gt(nextUpdateTimeBefore);
    });

    it("Should process transparent vaults", async function () {
      const { orchestrator, automationRegistry } = await loadFixture(deployOrchestratorFixture);

      await ethers.provider.send("evm_increaseTime", [1e18]);
      await ethers.provider.send("evm_mine", []);

      // This should not revert even though vaults have no portfolio yet
      await expect(orchestrator.connect(automationRegistry).performUpkeep("0x")).to.not.be.reverted;
    });

    it("Should process encrypted vaults", async function () {
      const { orchestrator, automationRegistry } = await loadFixture(deployOrchestratorFixture);

      await ethers.provider.send("evm_increaseTime", [1e18]);
      await ethers.provider.send("evm_mine", []);

      // This should not revert even though encrypted vaults have no portfolio yet
      await expect(orchestrator.connect(automationRegistry).performUpkeep("0x")).to.not.be.reverted;
    });

    it("Should handle empty vault lists", async function () {
      const { orchestrator, automationRegistry, orionConfig, vaultFactory } =
        await loadFixture(deployOrchestratorFixture);

      // Remove all vaults from config
      const transparentVaults = await orionConfig.getAllOrionVaults(1); // Transparent
      for (const vault of transparentVaults) {
        await orionConfig.connect(vaultFactory).removeOrionVault(vault, 1);
      }

      const encryptedVaults = await orionConfig.getAllOrionVaults(0); // Encrypted
      for (const vault of encryptedVaults) {
        await orionConfig.connect(vaultFactory).removeOrionVault(vault, 0);
      }

      await ethers.provider.send("evm_increaseTime", [1e18]);
      await ethers.provider.send("evm_mine", []);

      // Should still process successfully with no vaults
      await expect(orchestrator.connect(automationRegistry).performUpkeep("0x")).to.not.be.reverted;
    });
  });

  describe("Time Management", function () {
    it("Should allow multiple upkeeps with proper intervals", async function () {
      const { orchestrator, automationRegistry } = await loadFixture(deployOrchestratorFixture);

      // First upkeep
      await ethers.provider.send("evm_increaseTime", [1e18]);
      await ethers.provider.send("evm_mine", []);
      await orchestrator.connect(automationRegistry).performUpkeep("0x");
      expect(await orchestrator.epochCounter()).to.equal(1);

      // Second upkeep
      await ethers.provider.send("evm_increaseTime", [1e18]);
      await ethers.provider.send("evm_mine", []);
      await orchestrator.connect(automationRegistry).performUpkeep("0x");
      expect(await orchestrator.epochCounter()).to.equal(2);
    });
  });
});
