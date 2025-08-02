import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";

import {
  ERC4626ExecutionAdapter,
  ERC4626PriceAdapter,
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  MockERC4626Asset,
  MockPriceAdapter,
  MockUnderlyingAsset,
  PriceAdapterRegistry,
  OrionConfig,
  OrionEncryptedVault,
  OrionTransparentVault,
  OrionVaultFactory,
} from "../typechain-types";

describe("OnlyOwner Functions - Comprehensive Test Suite", function () {
  let owner: SignerWithAddress;
  let nonOwner: SignerWithAddress;
  let user1: SignerWithAddress;
  let automationRegistry: SignerWithAddress;

  // Contract instances
  let orionConfig: OrionConfig;
  let priceAdapterRegistry: PriceAdapterRegistry;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let orionVaultFactory: OrionVaultFactory;
  let internalStatesOrchestrator: InternalStatesOrchestrator;
  let erc4626ExecutionAdapter: ERC4626ExecutionAdapter;
  let erc4626PriceAdapter: ERC4626PriceAdapter;
  let mockUnderlyingAsset: MockUnderlyingAsset;
  let mockPriceAdapter: MockPriceAdapter;

  // Helper contracts
  let mockERC4626Asset: MockERC4626Asset;
  let transparentVaultImpl: OrionTransparentVault;
  let encryptedVaultImpl: OrionEncryptedVault;

  const ZERO_ADDRESS = ethers.ZeroAddress;

  beforeEach(async function () {
    [owner, nonOwner, user1, user2, automationRegistry] = await ethers.getSigners();

    // Deploy mock contracts first
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    mockUnderlyingAsset = await MockUnderlyingAssetFactory.deploy(6);
    await mockUnderlyingAsset.waitForDeployment();

    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    mockERC4626Asset = await MockERC4626AssetFactory.deploy(mockUnderlyingAsset.target, "Mock Vault", "MVAULT", 18);
    await mockERC4626Asset.waitForDeployment();

    // Deploy OrionConfig
    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    orionConfig = await upgrades.deployProxy(OrionConfigFactory, [owner.address], {
      kind: "uups",
      initializer: "initialize",
    });
    await orionConfig.waitForDeployment();
    await orionConfig.setUnderlyingAsset(mockUnderlyingAsset.target);

    // Deploy PriceAdapterRegistryFactory
    const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
    priceAdapterRegistry = await upgrades.deployProxy(
      PriceAdapterRegistryFactory,
      [owner.address, orionConfig.target],
      {
        kind: "uups",
        initializer: "initialize",
      },
    );
    await priceAdapterRegistry.waitForDeployment();

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
      .setProtocolParams(liquidityOrchestrator.target, 6, orionVaultFactory.target, priceAdapterRegistry.target);

    // Set implementations in factory
    await orionVaultFactory.connect(owner).setImplementations(transparentVaultImpl.target, encryptedVaultImpl.target);
  });

  describe("OrionConfig onlyOwner Functions", function () {
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

  describe("PriceAdapterRegistry onlyOwner Functions", function () {
    describe("upgradeability", function () {
      it("should succeed when owner calls upgradeToAndCall", async function () {
        const PriceAdapterRegistryV2Factory = await ethers.getContractFactory("PriceAdapterRegistry");
        await expect(upgrades.upgradeProxy(priceAdapterRegistry.target, PriceAdapterRegistryV2Factory)).to.not.be
          .reverted;
      });

      it("should revert when non-owner tries to upgrade", async function () {
        const PriceAdapterRegistryV2Factory = await ethers.getContractFactory("PriceAdapterRegistry");
        const priceAdapterRegistryV2 = await PriceAdapterRegistryV2Factory.deploy();
        await priceAdapterRegistryV2.waitForDeployment();

        await expect(
          priceAdapterRegistry.connect(nonOwner).upgradeToAndCall(priceAdapterRegistryV2.target, "0x"),
        ).to.be.revertedWithCustomError(priceAdapterRegistry, "OwnableUnauthorizedAccount");
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
});
