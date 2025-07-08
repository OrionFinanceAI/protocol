import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";

describe("OnlyOwner Functions - Comprehensive Test Suite", function () {
  let owner: SignerWithAddress;
  let nonOwner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let automationRegistry: SignerWithAddress;

  // Contract instances
  let orionConfig: any;
  let oracleRegistry: any;
  let liquidityOrchestrator: any;
  let orionVaultFactory: any;
  let internalStatesOrchestrator: any;
  let erc4626ExecutionAdapter: any;
  let erc4626PriceAdapter: any;
  let mockUnderlyingAsset: any;
  let mockPriceAdapter: any;

  // Helper contracts
  let mockERC4626Asset: any;
  let transparentVaultImpl: any;
  let encryptedVaultImpl: any;

  const ZERO_ADDRESS = ethers.ZeroAddress;

  beforeEach(async function () {
    [owner, nonOwner, user1, user2, automationRegistry] = await ethers.getSigners();

    // Deploy mock contracts first
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    mockUnderlyingAsset = await MockUnderlyingAssetFactory.deploy();
    await mockUnderlyingAsset.waitForDeployment();

    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    mockERC4626Asset = await MockERC4626AssetFactory.deploy(mockUnderlyingAsset.target, "Mock Vault", "MVAULT");
    await mockERC4626Asset.waitForDeployment();

    // Deploy OrionConfig
    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    orionConfig = await upgrades.deployProxy(OrionConfigFactory, [owner.address], {
      kind: "uups",
      initializer: "initialize",
    });
    await orionConfig.waitForDeployment();

    // Deploy OracleRegistry
    const OracleRegistryFactory = await ethers.getContractFactory("OracleRegistry");
    oracleRegistry = await upgrades.deployProxy(OracleRegistryFactory, [owner.address], {
      kind: "uups",
      initializer: "initialize",
    });
    await oracleRegistry.waitForDeployment();

    // Deploy MockPriceAdapter
    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    mockPriceAdapter = await upgrades.deployProxy(MockPriceAdapterFactory, [owner.address], {
      kind: "uups",
      initializer: "initialize",
    });
    await mockPriceAdapter.waitForDeployment();

    // Deploy ERC4626PriceAdapter
    const ERC4626PriceAdapterFactory = await ethers.getContractFactory("ERC4626PriceAdapter");
    erc4626PriceAdapter = await upgrades.deployProxy(ERC4626PriceAdapterFactory, [owner.address], {
      kind: "uups",
      initializer: "initialize",
    });
    await erc4626PriceAdapter.waitForDeployment();

    // Deploy LiquidityOrchestrator
    const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
    liquidityOrchestrator = await upgrades.deployProxy(
      LiquidityOrchestratorFactory,
      [owner.address, automationRegistry.address, orionConfig.target],
      {
        kind: "uups",
        initializer: "initialize",
      },
    );
    await liquidityOrchestrator.waitForDeployment();

    // Deploy InternalStatesOrchestrator
    const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
    internalStatesOrchestrator = await upgrades.deployProxy(
      InternalStatesOrchestratorFactory,
      [owner.address, automationRegistry.address, orionConfig.target],
      {
        kind: "uups",
        initializer: "initialize",
      },
    );
    await internalStatesOrchestrator.waitForDeployment();

    // Deploy OrionVaultFactory
    const OrionVaultFactoryFactory = await ethers.getContractFactory("OrionVaultFactory");
    orionVaultFactory = await upgrades.deployProxy(OrionVaultFactoryFactory, [owner.address, orionConfig.target], {
      kind: "uups",
      initializer: "initialize",
    });
    await orionVaultFactory.waitForDeployment();

    // Deploy ERC4626ExecutionAdapter
    const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
    erc4626ExecutionAdapter = await upgrades.deployProxy(ERC4626ExecutionAdapterFactory, [owner.address], {
      kind: "uups",
      initializer: "initialize",
    });
    await erc4626ExecutionAdapter.waitForDeployment();

    // Deploy vault implementations for factory testing
    const OrionTransparentVaultFactory = await ethers.getContractFactory("OrionTransparentVault");
    transparentVaultImpl = await OrionTransparentVaultFactory.deploy();
    await transparentVaultImpl.waitForDeployment();

    const OrionEncryptedVaultFactory = await ethers.getContractFactory("OrionEncryptedVault");
    encryptedVaultImpl = await OrionEncryptedVaultFactory.deploy();
    await encryptedVaultImpl.waitForDeployment();

    // Set up OrionConfig with protocol params
    await orionConfig
      .connect(owner)
      .setProtocolParams(
        mockUnderlyingAsset.target,
        internalStatesOrchestrator.target,
        liquidityOrchestrator.target,
        6,
        18,
        orionVaultFactory.target,
        oracleRegistry.target,
      );

    // Set implementations in factory
    await orionVaultFactory.connect(owner).setImplementations(transparentVaultImpl.target, encryptedVaultImpl.target);
  });

  describe("OrionConfig onlyOwner Functions", function () {
    describe("setProtocolParams", function () {
      it("should succeed when called by owner", async function () {
        await expect(
          orionConfig
            .connect(owner)
            .setProtocolParams(
              mockUnderlyingAsset.target,
              user1.address,
              user2.address,
              6,
              18,
              orionVaultFactory.target,
              oracleRegistry.target,
            ),
        ).to.emit(orionConfig, "ProtocolParamsUpdated");
      });

      it("should revert when called by non-owner", async function () {
        await expect(
          orionConfig
            .connect(nonOwner)
            .setProtocolParams(
              mockUnderlyingAsset.target,
              user1.address,
              user2.address,
              6,
              18,
              orionVaultFactory.target,
              oracleRegistry.target,
            ),
        ).to.be.revertedWithCustomError(orionConfig, "OwnableUnauthorizedAccount");
      });
    });

    describe("addWhitelistedAsset", function () {
      it("should succeed when called by owner", async function () {
        await expect(orionConfig.connect(owner).addWhitelistedAsset(user1.address))
          .to.emit(orionConfig, "WhitelistedAssetAdded")
          .withArgs(user1.address);
      });

      it("should revert when called by non-owner", async function () {
        await expect(orionConfig.connect(nonOwner).addWhitelistedAsset(user1.address)).to.be.revertedWithCustomError(
          orionConfig,
          "OwnableUnauthorizedAccount",
        );
      });
    });

    describe("removeWhitelistedAsset", function () {
      beforeEach(async function () {
        await orionConfig.connect(owner).addWhitelistedAsset(user1.address);
      });

      it("should succeed when called by owner", async function () {
        await expect(orionConfig.connect(owner).removeWhitelistedAsset(user1.address))
          .to.emit(orionConfig, "WhitelistedAssetRemoved")
          .withArgs(user1.address);
      });

      it("should revert when called by non-owner", async function () {
        await expect(orionConfig.connect(nonOwner).removeWhitelistedAsset(user1.address)).to.be.revertedWithCustomError(
          orionConfig,
          "OwnableUnauthorizedAccount",
        );
      });
    });

    describe("upgradeability", function () {
      it("should succeed when owner calls upgradeToAndCall", async function () {
        const OrionConfigV2Factory = await ethers.getContractFactory("OrionConfig");
        const orionConfigV2 = await OrionConfigV2Factory.deploy();
        await orionConfigV2.waitForDeployment();

        await expect(upgrades.upgradeProxy(orionConfig.target, OrionConfigV2Factory)).to.not.be.reverted;
      });

      it("should revert when non-owner tries to upgrade", async function () {
        const OrionConfigV2Factory = await ethers.getContractFactory("OrionConfig");
        const orionConfigV2 = await OrionConfigV2Factory.deploy();
        await orionConfigV2.waitForDeployment();

        await expect(
          orionConfig.connect(nonOwner).upgradeToAndCall(orionConfigV2.target, "0x"),
        ).to.be.revertedWithCustomError(orionConfig, "OwnableUnauthorizedAccount");
      });
    });
  });

  describe("OracleRegistry onlyOwner Functions", function () {
    describe("setAdapter", function () {
      it("should succeed when called by owner", async function () {
        await expect(oracleRegistry.connect(owner).setAdapter(user1.address, mockPriceAdapter.target))
          .to.emit(oracleRegistry, "AdapterSet")
          .withArgs(user1.address, mockPriceAdapter.target);
      });

      it("should revert when called by non-owner", async function () {
        await expect(
          oracleRegistry.connect(nonOwner).setAdapter(user1.address, mockPriceAdapter.target),
        ).to.be.revertedWithCustomError(oracleRegistry, "OwnableUnauthorizedAccount");
      });
    });

    describe("upgradeability", function () {
      it("should succeed when owner calls upgradeToAndCall", async function () {
        const OracleRegistryV2Factory = await ethers.getContractFactory("OracleRegistry");
        await expect(upgrades.upgradeProxy(oracleRegistry.target, OracleRegistryV2Factory)).to.not.be.reverted;
      });

      it("should revert when non-owner tries to upgrade", async function () {
        const OracleRegistryV2Factory = await ethers.getContractFactory("OracleRegistry");
        const oracleRegistryV2 = await OracleRegistryV2Factory.deploy();
        await oracleRegistryV2.waitForDeployment();

        await expect(
          oracleRegistry.connect(nonOwner).upgradeToAndCall(oracleRegistryV2.target, "0x"),
        ).to.be.revertedWithCustomError(oracleRegistry, "OwnableUnauthorizedAccount");
      });
    });
  });

  describe("LiquidityOrchestrator onlyOwner Functions", function () {
    describe("updateAutomationRegistry", function () {
      it("should succeed when called by owner", async function () {
        await expect(liquidityOrchestrator.connect(owner).updateAutomationRegistry(user1.address))
          .to.emit(liquidityOrchestrator, "AutomationRegistryUpdated")
          .withArgs(user1.address);
      });

      it("should revert when called by non-owner", async function () {
        await expect(
          liquidityOrchestrator.connect(nonOwner).updateAutomationRegistry(user1.address),
        ).to.be.revertedWithCustomError(liquidityOrchestrator, "OwnableUnauthorizedAccount");
      });
    });

    describe("updateConfig", function () {
      it("should succeed when called by owner", async function () {
        await expect(liquidityOrchestrator.connect(owner).updateConfig(user1.address)).to.not.be.reverted;
        expect(await liquidityOrchestrator.config()).to.equal(user1.address);
      });

      it("should revert when called by non-owner", async function () {
        await expect(liquidityOrchestrator.connect(nonOwner).updateConfig(user1.address)).to.be.revertedWithCustomError(
          liquidityOrchestrator,
          "OwnableUnauthorizedAccount",
        );
      });
    });

    describe("setAdapter", function () {
      it("should succeed when called by owner", async function () {
        await expect(liquidityOrchestrator.connect(owner).setAdapter(user1.address, erc4626ExecutionAdapter.target))
          .to.emit(liquidityOrchestrator, "AdapterSet")
          .withArgs(user1.address, erc4626ExecutionAdapter.target);
      });

      it("should revert when called by non-owner", async function () {
        await expect(
          liquidityOrchestrator.connect(nonOwner).setAdapter(user1.address, erc4626ExecutionAdapter.target),
        ).to.be.revertedWithCustomError(liquidityOrchestrator, "OwnableUnauthorizedAccount");
      });
    });

    describe("upgradeability", function () {
      it("should succeed when owner calls upgradeToAndCall", async function () {
        const LiquidityOrchestratorV2Factory = await ethers.getContractFactory("LiquidityOrchestrator");
        await expect(upgrades.upgradeProxy(liquidityOrchestrator.target, LiquidityOrchestratorV2Factory)).to.not.be
          .reverted;
      });

      it("should revert when non-owner tries to upgrade", async function () {
        const LiquidityOrchestratorV2Factory = await ethers.getContractFactory("LiquidityOrchestrator");
        const liquidityOrchestratorV2 = await LiquidityOrchestratorV2Factory.deploy();
        await liquidityOrchestratorV2.waitForDeployment();

        await expect(
          liquidityOrchestrator.connect(nonOwner).upgradeToAndCall(liquidityOrchestratorV2.target, "0x"),
        ).to.be.revertedWithCustomError(liquidityOrchestrator, "OwnableUnauthorizedAccount");
      });
    });
  });

  describe("OrionVaultFactory onlyOwner Functions", function () {
    describe("updateConfig", function () {
      it("should succeed when called by owner", async function () {
        await expect(orionVaultFactory.connect(owner).updateConfig(user1.address)).to.not.be.reverted;
        expect(await orionVaultFactory.config()).to.equal(user1.address);
      });

      it("should revert when called by non-owner", async function () {
        await expect(orionVaultFactory.connect(nonOwner).updateConfig(user1.address)).to.be.revertedWithCustomError(
          orionVaultFactory,
          "OwnableUnauthorizedAccount",
        );
      });
    });

    describe("setImplementations", function () {
      it("should succeed when called by owner", async function () {
        await expect(
          orionVaultFactory.connect(owner).setImplementations(transparentVaultImpl.target, encryptedVaultImpl.target),
        ).to.not.be.reverted;
        expect(await orionVaultFactory.transparentVaultImplementation()).to.equal(transparentVaultImpl.target);
        expect(await orionVaultFactory.encryptedVaultImplementation()).to.equal(encryptedVaultImpl.target);
      });

      it("should revert when called by non-owner", async function () {
        await expect(
          orionVaultFactory
            .connect(nonOwner)
            .setImplementations(transparentVaultImpl.target, encryptedVaultImpl.target),
        ).to.be.revertedWithCustomError(orionVaultFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("createOrionTransparentVault", function () {
      it("should succeed when called by owner", async function () {
        await expect(orionVaultFactory.connect(owner).createOrionTransparentVault(user1.address, "Test", "TST"))
          .to.emit(orionVaultFactory, "OrionVaultCreated")
          .and.to.emit(orionConfig, "OrionVaultAdded");
      });

      it("should revert when called by non-owner", async function () {
        await expect(
          orionVaultFactory.connect(nonOwner).createOrionTransparentVault(user1.address, "Test", "TST"),
        ).to.be.revertedWithCustomError(orionVaultFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("createOrionEncryptedVault", function () {
      it("should succeed when called by owner", async function () {
        await expect(orionVaultFactory.connect(owner).createOrionEncryptedVault(user1.address, "Test", "TST"))
          .to.emit(orionVaultFactory, "OrionVaultCreated")
          .and.to.emit(orionConfig, "OrionVaultAdded");
      });

      it("should revert when called by non-owner", async function () {
        await expect(
          orionVaultFactory.connect(nonOwner).createOrionEncryptedVault(user1.address, "Test", "TST"),
        ).to.be.revertedWithCustomError(orionVaultFactory, "OwnableUnauthorizedAccount");
      });
    });

    describe("upgradeability", function () {
      it("should succeed when owner calls upgradeToAndCall", async function () {
        const OrionVaultFactoryV2Factory = await ethers.getContractFactory("OrionVaultFactory");
        await expect(upgrades.upgradeProxy(orionVaultFactory.target, OrionVaultFactoryV2Factory)).to.not.be.reverted;
      });

      it("should revert when non-owner tries to upgrade", async function () {
        const OrionVaultFactoryV2Factory = await ethers.getContractFactory("OrionVaultFactory");
        const orionVaultFactoryV2 = await OrionVaultFactoryV2Factory.deploy();
        await orionVaultFactoryV2.waitForDeployment();

        await expect(
          orionVaultFactory.connect(nonOwner).upgradeToAndCall(orionVaultFactoryV2.target, "0x"),
        ).to.be.revertedWithCustomError(orionVaultFactory, "OwnableUnauthorizedAccount");
      });
    });
  });

  describe("InternalStatesOrchestrator onlyOwner Functions", function () {
    describe("updateAutomationRegistry", function () {
      it("should succeed when called by owner", async function () {
        await expect(internalStatesOrchestrator.connect(owner).updateAutomationRegistry(user1.address))
          .to.emit(internalStatesOrchestrator, "AutomationRegistryUpdated")
          .withArgs(user1.address);
      });

      it("should revert when called by non-owner", async function () {
        await expect(
          internalStatesOrchestrator.connect(nonOwner).updateAutomationRegistry(user1.address),
        ).to.be.revertedWithCustomError(internalStatesOrchestrator, "OwnableUnauthorizedAccount");
      });
    });

    describe("updateConfig", function () {
      it("should succeed when called by owner", async function () {
        await expect(internalStatesOrchestrator.connect(owner).updateConfig(user1.address)).to.not.be.reverted;
        expect(await internalStatesOrchestrator.config()).to.equal(user1.address);
      });

      it("should revert when called by non-owner", async function () {
        await expect(
          internalStatesOrchestrator.connect(nonOwner).updateConfig(user1.address),
        ).to.be.revertedWithCustomError(internalStatesOrchestrator, "OwnableUnauthorizedAccount");
      });
    });

    describe("upgradeability", function () {
      it("should succeed when owner calls upgradeToAndCall", async function () {
        const InternalStatesOrchestratorV2Factory = await ethers.getContractFactory("InternalStatesOrchestrator");
        await expect(upgrades.upgradeProxy(internalStatesOrchestrator.target, InternalStatesOrchestratorV2Factory)).to
          .not.be.reverted;
      });

      it("should revert when non-owner tries to upgrade", async function () {
        const InternalStatesOrchestratorV2Factory = await ethers.getContractFactory("InternalStatesOrchestrator");
        const internalStatesOrchestratorV2 = await InternalStatesOrchestratorV2Factory.deploy();
        await internalStatesOrchestratorV2.waitForDeployment();

        await expect(
          internalStatesOrchestrator.connect(nonOwner).upgradeToAndCall(internalStatesOrchestratorV2.target, "0x"),
        ).to.be.revertedWithCustomError(internalStatesOrchestrator, "OwnableUnauthorizedAccount");
      });
    });
  });

  describe("ERC4626ExecutionAdapter onlyOwner Functions", function () {
    describe("upgradeability", function () {
      it("should succeed when owner calls upgradeToAndCall", async function () {
        const ERC4626ExecutionAdapterV2Factory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
        await expect(upgrades.upgradeProxy(erc4626ExecutionAdapter.target, ERC4626ExecutionAdapterV2Factory)).to.not.be
          .reverted;
      });

      it("should revert when non-owner tries to upgrade", async function () {
        const ERC4626ExecutionAdapterV2Factory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
        const erc4626ExecutionAdapterV2 = await ERC4626ExecutionAdapterV2Factory.deploy();
        await erc4626ExecutionAdapterV2.waitForDeployment();

        await expect(
          erc4626ExecutionAdapter.connect(nonOwner).upgradeToAndCall(erc4626ExecutionAdapterV2.target, "0x"),
        ).to.be.revertedWithCustomError(erc4626ExecutionAdapter, "OwnableUnauthorizedAccount");
      });
    });
  });

  describe("ERC4626PriceAdapter onlyOwner Functions", function () {
    describe("upgradeability", function () {
      it("should succeed when owner calls upgradeToAndCall", async function () {
        const ERC4626PriceAdapterV2Factory = await ethers.getContractFactory("ERC4626PriceAdapter");
        await expect(upgrades.upgradeProxy(erc4626PriceAdapter.target, ERC4626PriceAdapterV2Factory)).to.not.be
          .reverted;
      });

      it("should revert when non-owner tries to upgrade", async function () {
        const ERC4626PriceAdapterV2Factory = await ethers.getContractFactory("ERC4626PriceAdapter");
        const erc4626PriceAdapterV2 = await ERC4626PriceAdapterV2Factory.deploy();
        await erc4626PriceAdapterV2.waitForDeployment();

        await expect(
          erc4626PriceAdapter.connect(nonOwner).upgradeToAndCall(erc4626PriceAdapterV2.target, "0x"),
        ).to.be.revertedWithCustomError(erc4626PriceAdapter, "OwnableUnauthorizedAccount");
      });
    });
  });

  describe("MockPriceAdapter onlyOwner Functions", function () {
    describe("upgradeability", function () {
      it("should succeed when owner calls upgradeToAndCall", async function () {
        const MockPriceAdapterV2Factory = await ethers.getContractFactory("MockPriceAdapter");
        await expect(upgrades.upgradeProxy(mockPriceAdapter.target, MockPriceAdapterV2Factory)).to.not.be.reverted;
      });

      it("should revert when non-owner tries to upgrade", async function () {
        const MockPriceAdapterV2Factory = await ethers.getContractFactory("MockPriceAdapter");
        const mockPriceAdapterV2 = await MockPriceAdapterV2Factory.deploy();
        await mockPriceAdapterV2.waitForDeployment();

        await expect(
          mockPriceAdapter.connect(nonOwner).upgradeToAndCall(mockPriceAdapterV2.target, "0x"),
        ).to.be.revertedWithCustomError(mockPriceAdapter, "OwnableUnauthorizedAccount");
      });
    });
  });

  describe("MockUnderlyingAsset onlyOwner Functions", function () {
    describe("mint", function () {
      it("should succeed when called by owner", async function () {
        const amount = ethers.parseUnits("1000", 6);
        await expect(mockUnderlyingAsset.connect(owner).mint(user1.address, amount))
          .to.emit(mockUnderlyingAsset, "Transfer")
          .withArgs(ZERO_ADDRESS, user1.address, amount);
      });

      it("should revert when called by non-owner", async function () {
        const amount = ethers.parseUnits("1000", 6);
        await expect(mockUnderlyingAsset.connect(nonOwner).mint(user1.address, amount)).to.be.revertedWithCustomError(
          mockUnderlyingAsset,
          "OwnableUnauthorizedAccount",
        );
      });
    });
  });

  describe("Edge Cases and Security Tests", function () {
    it("should prevent zero address parameters where applicable", async function () {
      // Test OrionConfig setProtocolParams with zero addresses
      await expect(
        orionConfig
          .connect(owner)
          .setProtocolParams(
            ZERO_ADDRESS,
            user1.address,
            user2.address,
            6,
            18,
            orionVaultFactory.target,
            oracleRegistry.target,
          ),
      ).to.be.revertedWithCustomError(orionConfig, "ZeroAddress");

      // Test OracleRegistry setAdapter with zero addresses
      await expect(
        oracleRegistry.connect(owner).setAdapter(ZERO_ADDRESS, mockPriceAdapter.target),
      ).to.be.revertedWithCustomError(oracleRegistry, "ZeroAddress");

      await expect(oracleRegistry.connect(owner).setAdapter(user1.address, ZERO_ADDRESS)).to.be.revertedWithCustomError(
        oracleRegistry,
        "ZeroAddress",
      );

      // Test LiquidityOrchestrator updateAutomationRegistry with zero address
      await expect(
        liquidityOrchestrator.connect(owner).updateAutomationRegistry(ZERO_ADDRESS),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "ZeroAddress");

      // Test OrionVaultFactory setImplementations with zero addresses
      await expect(
        orionVaultFactory.connect(owner).setImplementations(ZERO_ADDRESS, user2.address),
      ).to.be.revertedWithCustomError(orionVaultFactory, "ZeroAddress");

      await expect(
        orionVaultFactory.connect(owner).setImplementations(user1.address, ZERO_ADDRESS),
      ).to.be.revertedWithCustomError(orionVaultFactory, "ZeroAddress");
    });

    it("should maintain state consistency after owner transfers", async function () {
      // Transfer ownership of OrionConfig
      await orionConfig.connect(owner).transferOwnership(user1.address);
      await orionConfig.connect(user1).acceptOwnership();

      // Original owner should no longer have access
      await expect(orionConfig.connect(owner).addWhitelistedAsset(user2.address)).to.be.revertedWithCustomError(
        orionConfig,
        "OwnableUnauthorizedAccount",
      );

      // New owner should have access
      await expect(orionConfig.connect(user1).addWhitelistedAsset(user2.address))
        .to.emit(orionConfig, "WhitelistedAssetAdded")
        .withArgs(user2.address);
    });

    it("should prevent function calls during ownership transfer", async function () {
      // Start ownership transfer
      await orionConfig.connect(owner).transferOwnership(user1.address);

      // Original owner should still have access until transfer is accepted
      await expect(orionConfig.connect(owner).addWhitelistedAsset(user2.address))
        .to.emit(orionConfig, "WhitelistedAssetAdded")
        .withArgs(user2.address);

      // New owner should not have access until accepted
      await expect(orionConfig.connect(user1).removeWhitelistedAsset(user2.address)).to.be.revertedWithCustomError(
        orionConfig,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  describe("Integration Tests", function () {
    it("should allow owner to configure complete system", async function () {
      // Set up oracle adapters
      await oracleRegistry.connect(owner).setAdapter(mockERC4626Asset.target, erc4626PriceAdapter.target);
      await oracleRegistry.connect(owner).setAdapter(mockUnderlyingAsset.target, mockPriceAdapter.target);

      // Set up execution adapters
      await liquidityOrchestrator.connect(owner).setAdapter(mockERC4626Asset.target, erc4626ExecutionAdapter.target);

      // Whitelist assets
      await orionConfig.connect(owner).addWhitelistedAsset(mockERC4626Asset.target);
      await orionConfig.connect(owner).addWhitelistedAsset(mockUnderlyingAsset.target);

      // Create vaults
      const transparentVaultTx = await orionVaultFactory
        .connect(owner)
        .createOrionTransparentVault(user1.address, "Test Transparent", "TT");
      const encryptedVaultTx = await orionVaultFactory
        .connect(owner)
        .createOrionEncryptedVault(user1.address, "Test Encrypted", "TE");

      // Verify everything was set up correctly
      expect(await oracleRegistry.adapterOf(mockERC4626Asset.target)).to.equal(erc4626PriceAdapter.target);
      expect(await liquidityOrchestrator.executionAdapterOf(mockERC4626Asset.target)).to.equal(
        erc4626ExecutionAdapter.target,
      );
      expect(await orionConfig.isWhitelisted(mockERC4626Asset.target)).to.be.true;
      expect(await orionConfig.isWhitelisted(mockUnderlyingAsset.target)).to.be.true;
    });

    it("should prevent non-owners from disrupting system configuration", async function () {
      // Try to disrupt oracle configuration
      await expect(
        oracleRegistry.connect(nonOwner).setAdapter(mockERC4626Asset.target, ZERO_ADDRESS),
      ).to.be.revertedWithCustomError(oracleRegistry, "OwnableUnauthorizedAccount");

      // Try to disrupt execution adapter configuration
      await expect(
        liquidityOrchestrator.connect(nonOwner).setAdapter(mockERC4626Asset.target, ZERO_ADDRESS),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "OwnableUnauthorizedAccount");

      // Try to disrupt whitelist
      await expect(orionConfig.connect(nonOwner).addWhitelistedAsset(ZERO_ADDRESS)).to.be.revertedWithCustomError(
        orionConfig,
        "OwnableUnauthorizedAccount",
      );

      // Try to create unauthorized vaults
      await expect(
        orionVaultFactory.connect(nonOwner).createOrionTransparentVault(user1.address, "Malicious", "MAL"),
      ).to.be.revertedWithCustomError(orionVaultFactory, "OwnableUnauthorizedAccount");
    });
  });
});
