import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("LiquidityOrchestrator", function () {
  // Test fixture setup
  async function deployLiquidityOrchestratorFixture() {
    const [owner, automationRegistry, vaultFactory, curator1, curator2, depositor1, depositor2, unauthorized] =
      await ethers.getSigners();

    // Deploy underlying asset (USDC-like, 6 decimals)
    const UnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAsset = await UnderlyingAssetFactory.deploy(6);
    await underlyingAsset.waitForDeployment();

    // Deploy ERC4626 assets
    const ERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");

    const erc4626Asset1 = await ERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Vault Token 1",
      "VT1",
      18,
    );
    await erc4626Asset1.waitForDeployment();
    const erc4626Asset2 = await ERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Vault Token 2",
      "VT2",
      18,
    );
    await erc4626Asset2.waitForDeployment();

    // Deploy OrionConfig
    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    const config = await OrionConfigFactory.deploy();
    await config.waitForDeployment();
    await config.initialize(owner.address);

    // Deploy OracleRegistry
    const OracleRegistryFactory = await ethers.getContractFactory("OracleRegistry");
    const oracleRegistry = await OracleRegistryFactory.deploy();
    await oracleRegistry.waitForDeployment();
    await oracleRegistry.initialize(owner.address);

    // Deploy InternalStatesOrchestrator
    const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
    const internalStatesOrchestrator = await InternalStatesOrchestratorFactory.deploy();
    await internalStatesOrchestrator.waitForDeployment();
    await internalStatesOrchestrator.initialize(owner.address, automationRegistry.address, await config.getAddress());

    // Deploy LiquidityOrchestrator
    const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
    const liquidityOrchestratorContract = await LiquidityOrchestratorFactory.deploy();
    await liquidityOrchestratorContract.waitForDeployment();

    // Set protocol parameters in OrionConfig BEFORE initializing LiquidityOrchestrator
    await config.setProtocolParams(
      await underlyingAsset.getAddress(),
      await internalStatesOrchestrator.getAddress(),
      await liquidityOrchestratorContract.getAddress(),
      6, // statesDecimals
      6, // curatorIntentDecimals
      vaultFactory.address, // factory
      await oracleRegistry.getAddress(),
    );

    // Whitelist the ERC4626 assets so they can be used in vault intents
    await config.addWhitelistedAsset(await erc4626Asset1.getAddress());
    await config.addWhitelistedAsset(await erc4626Asset2.getAddress());

    // Initialize LiquidityOrchestrator after config parameters are set
    await liquidityOrchestratorContract.initialize(
      owner.address,
      automationRegistry.address,
      await config.getAddress(),
    );

    // Deploy price adapters for oracles
    const ERC4626PriceAdapterFactory = await ethers.getContractFactory("ERC4626PriceAdapter");

    const erc4626Oracle = await ERC4626PriceAdapterFactory.deploy();
    await erc4626Oracle.waitForDeployment();
    await erc4626Oracle.initialize(owner.address);

    // Set price adapters in registry
    await oracleRegistry.setAdapter(await erc4626Asset1.getAddress(), await erc4626Oracle.getAddress());
    await oracleRegistry.setAdapter(await erc4626Asset2.getAddress(), await erc4626Oracle.getAddress());

    // Deploy execution adapter for ERC4626 assets
    const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");

    const erc4626ExecutionAdapter = await ERC4626ExecutionAdapterFactory.deploy();
    await erc4626ExecutionAdapter.waitForDeployment();
    await erc4626ExecutionAdapter.initialize(owner.address);

    // Set adapters in LiquidityOrchestrator
    await liquidityOrchestratorContract.setAdapter(
      await erc4626Asset1.getAddress(),
      await erc4626ExecutionAdapter.getAddress(),
    );
    await liquidityOrchestratorContract.setAdapter(
      await erc4626Asset2.getAddress(),
      await erc4626ExecutionAdapter.getAddress(),
    );

    // Deploy two transparent vaults
    const OrionTransparentVaultFactory = await ethers.getContractFactory("OrionTransparentVault");

    const vault1 = await OrionTransparentVaultFactory.deploy();
    await vault1.waitForDeployment();
    await vault1.initialize(curator1.address, await config.getAddress(), "Test Vault 1", "TV1");

    const vault2 = await OrionTransparentVaultFactory.deploy();
    await vault2.waitForDeployment();
    await vault2.initialize(curator2.address, await config.getAddress(), "Test Vault 2", "TV2");

    // Add vaults to config registry.
    await config.connect(vaultFactory).addOrionVault(await vault1.getAddress(), 0);
    await config.connect(vaultFactory).addOrionVault(await vault2.getAddress(), 0);

    // Mint underlying assets to depositors
    await underlyingAsset.mint(depositor1.address, ethers.parseUnits("100000", 6));
    await underlyingAsset.mint(depositor2.address, ethers.parseUnits("100000", 6));

    return {
      config,
      oracleRegistry,
      internalStatesOrchestrator,
      liquidityOrchestratorContract,
      underlyingAsset,
      erc4626Asset1,
      erc4626Asset2,
      vault1,
      vault2,
      erc4626ExecutionAdapter,
      owner,
      automationRegistry,
      vaultFactory,
      curator1,
      curator2,
      depositor1,
      depositor2,
      unauthorized,
      erc4626Oracle,
    };
  }

  describe("Initialization", function () {
    it("Should initialize with correct parameters", async function () {
      const { liquidityOrchestratorContract, automationRegistry, config, internalStatesOrchestrator, owner } =
        await loadFixture(deployLiquidityOrchestratorFixture);

      expect(await liquidityOrchestratorContract.owner()).to.equal(owner.address);
      expect(await liquidityOrchestratorContract.automationRegistry()).to.equal(automationRegistry.address);
      expect(await liquidityOrchestratorContract.config()).to.equal(await config.getAddress());
      expect(await liquidityOrchestratorContract.internalStatesOrchestrator()).to.equal(
        await internalStatesOrchestrator.getAddress(),
      );
      expect(await liquidityOrchestratorContract.lastProcessedEpoch()).to.equal(0);
    });

    it("Should revert if initialized with zero automation registry", async function () {
      const { config, owner } = await loadFixture(deployLiquidityOrchestratorFixture);
      const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
      const liquidityOrchestrator = await LiquidityOrchestratorFactory.deploy();
      await liquidityOrchestrator.waitForDeployment();

      await expect(
        liquidityOrchestrator.initialize(owner.address, ethers.ZeroAddress, await config.getAddress()),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "ZeroAddress");
    });

    it("Should revert if initialized with zero config", async function () {
      const { automationRegistry, owner } = await loadFixture(deployLiquidityOrchestratorFixture);
      const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
      const liquidityOrchestrator = await LiquidityOrchestratorFactory.deploy();
      await liquidityOrchestrator.waitForDeployment();

      await expect(
        liquidityOrchestrator.initialize(owner.address, automationRegistry.address, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "ZeroAddress");
    });
  });

  describe("Access Control", function () {
    it("Should only allow owner to set adapters", async function () {
      const { liquidityOrchestratorContract, erc4626Asset1, erc4626ExecutionAdapter, unauthorized } = await loadFixture(
        deployLiquidityOrchestratorFixture,
      );

      await expect(
        liquidityOrchestratorContract
          .connect(unauthorized)
          .setAdapter(await erc4626Asset1.getAddress(), await erc4626ExecutionAdapter.getAddress()),
      ).to.be.revertedWithCustomError(liquidityOrchestratorContract, "OwnableUnauthorizedAccount");
    });

    it("Should only allow automation registry to perform upkeep", async function () {
      const { liquidityOrchestratorContract, unauthorized } = await loadFixture(deployLiquidityOrchestratorFixture);

      await expect(
        liquidityOrchestratorContract.connect(unauthorized).performUpkeep("0x"),
      ).to.be.revertedWithCustomError(liquidityOrchestratorContract, "NotAuthorized");
    });
  });

  describe("Adapter Management", function () {
    it("Should set and get adapters correctly", async function () {
      const { liquidityOrchestratorContract, erc4626Asset1, erc4626Asset2, erc4626ExecutionAdapter } =
        await loadFixture(deployLiquidityOrchestratorFixture);

      // Set adapter for erc4626Asset1
      expect(await liquidityOrchestratorContract.executionAdapterOf(await erc4626Asset1.getAddress())).to.equal(
        await erc4626ExecutionAdapter.getAddress(),
      );

      expect(await liquidityOrchestratorContract.executionAdapterOf(await erc4626Asset2.getAddress())).to.equal(
        await erc4626ExecutionAdapter.getAddress(),
      );
    });

    it("Should revert when setting adapter with zero asset address", async function () {
      const { liquidityOrchestratorContract, erc4626ExecutionAdapter } = await loadFixture(
        deployLiquidityOrchestratorFixture,
      );

      await expect(
        liquidityOrchestratorContract.setAdapter(ethers.ZeroAddress, await erc4626ExecutionAdapter.getAddress()),
      ).to.be.revertedWithCustomError(liquidityOrchestratorContract, "ZeroAddress");
    });

    it("Should revert when setting adapter with zero adapter address", async function () {
      const { liquidityOrchestratorContract, erc4626Asset1 } = await loadFixture(deployLiquidityOrchestratorFixture);

      await expect(
        liquidityOrchestratorContract.setAdapter(await erc4626Asset1.getAddress(), ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(liquidityOrchestratorContract, "ZeroAddress");
    });
  });
});
