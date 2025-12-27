import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  OrionConfig,
  OrionConfigV2,
  OrionTransparentVault,
  OrionTransparentVaultV2,
  TransparentVaultFactory,
  UpgradeableBeacon,
  MockUnderlyingAsset,
  PriceAdapterRegistry,
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
} from "../typechain-types";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";

describe("Upgrade Tests", function () {
  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let manager: SignerWithAddress;
  let user: SignerWithAddress;

  beforeEach(async function () {
    [owner, admin, manager, user] = await ethers.getSigners();
  });

  describe("UUPS Upgrade Pattern - OrionConfig", function () {
    let orionConfig: OrionConfig;
    let underlyingAsset: MockUnderlyingAsset;

    beforeEach(async function () {
      // Deploy mock underlying asset
      const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
      underlyingAsset = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset;
      await underlyingAsset.waitForDeployment();

      // Deploy OrionConfig using UUPS proxy
      const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
      orionConfig = (await upgrades.deployProxy(
        OrionConfigFactory,
        [owner.address, admin.address, await underlyingAsset.getAddress()],
        { initializer: "initialize", kind: "uups" },
      )) as unknown as OrionConfig;
      await orionConfig.waitForDeployment();
    });

    it("Should deploy OrionConfig V1 successfully", async function () {
      expect(await orionConfig.getAddress()).to.not.equal(ethers.ZeroAddress);
      expect(await orionConfig.owner()).to.equal(owner.address);
    });

    it("Should upgrade OrionConfig to V2 and preserve state", async function () {
      // Verify some initial state in V1
      expect(await orionConfig.owner()).to.equal(owner.address);
      expect(await orionConfig.underlyingAsset()).to.equal(await underlyingAsset.getAddress());

      // Get the proxy address
      const proxyAddress = await orionConfig.getAddress();

      // Upgrade to V2
      const OrionConfigV2Factory = await ethers.getContractFactory("OrionConfigV2");
      const orionConfigV2 = (await upgrades.upgradeProxy(
        proxyAddress,
        OrionConfigV2Factory,
      )) as unknown as OrionConfigV2;

      // Verify V1 state is preserved
      expect(await orionConfigV2.owner()).to.equal(owner.address);
      expect(await orionConfigV2.underlyingAsset()).to.equal(await underlyingAsset.getAddress());

      // Verify V2 functionality is available
      expect(await orionConfigV2.version()).to.equal("v2");

      // Test new V2 function
      const testValue = 42;
      await orionConfigV2.connect(owner).setV2Variable(testValue);
      expect(await orionConfigV2.newV2Variable()).to.equal(testValue);
    });

    it("Should emit V2VariableSet event when setting V2 variable", async function () {
      const proxyAddress = await orionConfig.getAddress();

      // Upgrade to V2
      const OrionConfigV2Factory = await ethers.getContractFactory("OrionConfigV2");
      const orionConfigV2 = (await upgrades.upgradeProxy(
        proxyAddress,
        OrionConfigV2Factory,
      )) as unknown as OrionConfigV2;

      // Test V2 event
      const testValue = 100;
      await expect(orionConfigV2.connect(owner).setV2Variable(testValue))
        .to.emit(orionConfigV2, "V2VariableSet")
        .withArgs(testValue);
    });

    it("Should only allow owner to upgrade", async function () {
      const proxyAddress = await orionConfig.getAddress();

      // Attempt upgrade as non-owner (should fail)
      const OrionConfigV2Factory = await ethers.getContractFactory("OrionConfigV2");
      await expect(
        upgrades.upgradeProxy(proxyAddress, OrionConfigV2Factory.connect(user)),
      ).to.be.revertedWithCustomError(orionConfig, "OwnableUnauthorizedAccount");
    });

    it("Should consume storage gap slots correctly", async function () {
      const proxyAddress = await orionConfig.getAddress();

      // Upgrade to V2
      const OrionConfigV2Factory = await ethers.getContractFactory("OrionConfigV2");
      const orionConfigV2 = (await upgrades.upgradeProxy(
        proxyAddress,
        OrionConfigV2Factory,
      )) as unknown as OrionConfigV2;

      // V2 adds one state variable (newV2Variable), which should use one slot from __gap
      // This should not cause any storage collision
      await orionConfigV2.connect(owner).setV2Variable(999);
      expect(await orionConfigV2.newV2Variable()).to.equal(999);

      // Original state should still be intact
      expect(await orionConfigV2.owner()).to.equal(owner.address);
    });
  });

  describe("Beacon Proxy Pattern - OrionTransparentVault", function () {
    let vaultFactory: TransparentVaultFactory;
    let vaultBeacon: UpgradeableBeacon;
    let vault1: OrionTransparentVault;
    let vault2: OrionTransparentVault;
    let underlyingAsset: MockUnderlyingAsset;

    beforeEach(async function () {
      const deployed = await deployUpgradeableProtocol(owner, admin);
      vaultFactory = deployed.transparentVaultFactory;
      vaultBeacon = deployed.vaultBeacon;
      underlyingAsset = deployed.underlyingAsset;

      // Whitelist vault owner (only if not already whitelisted)
      const isWhitelisted = await deployed.orionConfig.isWhitelistedVaultOwner(owner.address);
      if (!isWhitelisted) {
        await deployed.orionConfig.connect(owner).addWhitelistedVaultOwner(owner.address);
      }

      // Create two vaults (both will use the beacon)
      const tx1 = await vaultFactory.connect(owner).createVault(
        manager.address,
        "Test Vault 1",
        "TV1",
        0, // feeType
        0, // performanceFee
        0, // managementFee
        ethers.ZeroAddress, // depositAccessControl
      );
      const receipt1 = await tx1.wait();
      const vault1Event = receipt1?.logs.find((log) => {
        try {
          return vaultFactory.interface.parseLog(log)?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      const vault1Address = vault1Event ? vaultFactory.interface.parseLog(vault1Event)?.args[0] : undefined;

      const tx2 = await vaultFactory
        .connect(owner)
        .createVault(manager.address, "Test Vault 2", "TV2", 0, 0, 0, ethers.ZeroAddress);
      const receipt2 = await tx2.wait();
      const vault2Event = receipt2?.logs.find((log) => {
        try {
          return vaultFactory.interface.parseLog(log)?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      const vault2Address = vault2Event ? vaultFactory.interface.parseLog(vault2Event)?.args[0] : undefined;

      // Attach to vaults
      const VaultFactory = await ethers.getContractFactory("OrionTransparentVault");
      vault1 = VaultFactory.attach(vault1Address) as unknown as OrionTransparentVault;
      vault2 = VaultFactory.attach(vault2Address) as unknown as OrionTransparentVault;
    });

    it("Should deploy two vaults using the same beacon", async function () {
      expect(await vault1.getAddress()).to.not.equal(ethers.ZeroAddress);
      expect(await vault2.getAddress()).to.not.equal(ethers.ZeroAddress);
      expect(await vault1.getAddress()).to.not.equal(await vault2.getAddress());

      // Both vaults should point to the same implementation via beacon
      const implementation = await vaultBeacon.implementation();
      expect(implementation).to.not.equal(ethers.ZeroAddress);
    });

    it("Should upgrade all vaults simultaneously via beacon", async function () {
      // Set some state in both vaults
      await vault1.connect(owner).updateVaultWhitelist([await underlyingAsset.getAddress()]);
      await vault2.connect(owner).updateVaultWhitelist([await underlyingAsset.getAddress()]);

      // Verify vaults are deployed
      expect(await vault1.vaultOwner()).to.equal(owner.address);
      expect(await vault2.vaultOwner()).to.equal(owner.address);

      // Deploy V2 implementation
      const VaultV2Factory = await ethers.getContractFactory("OrionTransparentVaultV2");
      const vaultV2Impl = await VaultV2Factory.deploy();
      await vaultV2Impl.waitForDeployment();

      // Upgrade beacon to point to V2
      await vaultBeacon.connect(owner).upgradeTo(await vaultV2Impl.getAddress());

      // Attach as V2 contracts
      const vault1V2 = VaultV2Factory.attach(await vault1.getAddress()) as unknown as OrionTransparentVaultV2;
      const vault2V2 = VaultV2Factory.attach(await vault2.getAddress()) as unknown as OrionTransparentVaultV2;

      // Verify V1 state is preserved in both vaults
      expect(await vault1V2.vaultOwner()).to.equal(owner.address);
      expect(await vault2V2.vaultOwner()).to.equal(owner.address);

      // Verify V2 functionality is available in both vaults
      expect(await vault1V2.version()).to.equal("v2");
      expect(await vault2V2.version()).to.equal("v2");

      // Test new V2 function on both vaults
      await vault1V2.connect(owner).setVaultDescription("First vault upgraded to V2");
      await vault2V2.connect(owner).setVaultDescription("Second vault upgraded to V2");

      expect(await vault1V2.vaultDescription()).to.equal("First vault upgraded to V2");
      expect(await vault2V2.vaultDescription()).to.equal("Second vault upgraded to V2");
    });

    it("Should emit VaultDescriptionSet event when setting description in V2", async function () {
      // Deploy V2 implementation
      const VaultV2Factory = await ethers.getContractFactory("OrionTransparentVaultV2");
      const vaultV2Impl = await VaultV2Factory.deploy();
      await vaultV2Impl.waitForDeployment();

      // Upgrade beacon
      await vaultBeacon.connect(owner).upgradeTo(await vaultV2Impl.getAddress());

      // Attach as V2
      const vault1V2 = VaultV2Factory.attach(await vault1.getAddress()) as unknown as OrionTransparentVaultV2;

      // Test V2 event
      const description = "Test description";
      await expect(vault1V2.connect(owner).setVaultDescription(description))
        .to.emit(vault1V2, "VaultDescriptionSet")
        .withArgs(description);
    });

    it("Should only allow beacon owner to upgrade implementation", async function () {
      const VaultV2Factory = await ethers.getContractFactory("OrionTransparentVaultV2");
      const vaultV2Impl = await VaultV2Factory.deploy();
      await vaultV2Impl.waitForDeployment();

      // Attempt upgrade as non-owner (should fail)
      await expect(vaultBeacon.connect(user).upgradeTo(await vaultV2Impl.getAddress())).to.be.revertedWithCustomError(
        vaultBeacon,
        "OwnableUnauthorizedAccount",
      );
    });

    it("Should maintain independent vault states after upgrade", async function () {
      // Upgrade to V2
      const VaultV2Factory = await ethers.getContractFactory("OrionTransparentVaultV2");
      const vaultV2Impl = await VaultV2Factory.deploy();
      await vaultV2Impl.waitForDeployment();
      await vaultBeacon.connect(owner).upgradeTo(await vaultV2Impl.getAddress());

      // Attach as V2
      const vault1V2 = VaultV2Factory.attach(await vault1.getAddress()) as unknown as OrionTransparentVaultV2;
      const vault2V2 = VaultV2Factory.attach(await vault2.getAddress()) as unknown as OrionTransparentVaultV2;

      // Verify independent ownership is preserved
      expect(await vault1V2.vaultOwner()).to.equal(owner.address);
      expect(await vault2V2.vaultOwner()).to.equal(owner.address);
      expect(await vault1V2.manager()).to.equal(manager.address);
      expect(await vault2V2.manager()).to.equal(manager.address);

      // Set different V2 states
      await vault1V2.connect(owner).setVaultDescription("Vault 1 description");
      await vault2V2.connect(owner).setVaultDescription("Vault 2 description");

      expect(await vault1V2.vaultDescription()).to.equal("Vault 1 description");
      expect(await vault2V2.vaultDescription()).to.equal("Vault 2 description");
    });

    it("Should consume storage gap slots correctly in beacon upgrade", async function () {
      // Upgrade to V2
      const VaultV2Factory = await ethers.getContractFactory("OrionTransparentVaultV2");
      const vaultV2Impl = await VaultV2Factory.deploy();
      await vaultV2Impl.waitForDeployment();
      await vaultBeacon.connect(owner).upgradeTo(await vaultV2Impl.getAddress());

      const vault1V2 = VaultV2Factory.attach(await vault1.getAddress()) as unknown as OrionTransparentVaultV2;

      // V2 adds one state variable (vaultDescription - string), which uses storage gap
      await vault1V2.connect(owner).setVaultDescription("Testing storage gap");
      expect(await vault1V2.vaultDescription()).to.equal("Testing storage gap");

      // Original state should still be intact
      expect(await vault1V2.vaultOwner()).to.equal(owner.address);
      expect(await vault1V2.manager()).to.equal(manager.address);
    });
  });

  describe("Factory Upgrade Pattern", function () {
    let vaultFactory: TransparentVaultFactory;

    beforeEach(async function () {
      const deployed = await deployUpgradeableProtocol(owner, admin);
      vaultFactory = deployed.transparentVaultFactory;
    });

    it("Should upgrade factory itself via UUPS", async function () {
      expect(await vaultFactory.getAddress()).to.not.equal(ethers.ZeroAddress);

      // Factory is also upgradeable via UUPS
      // This test verifies the factory can be upgraded independently of vaults
      const factoryAddress = await vaultFactory.getAddress();
      const currentBeacon = await vaultFactory.vaultBeacon();

      // Re-deploy same implementation (in production would be V2)
      const FactoryFactory = await ethers.getContractFactory("TransparentVaultFactory");
      const upgradedFactory = await upgrades.upgradeProxy(factoryAddress, FactoryFactory);

      // Verify upgrade worked
      expect(await upgradedFactory.getAddress()).to.equal(factoryAddress);
      expect(await upgradedFactory.vaultBeacon()).to.equal(currentBeacon);
    });
  });

  describe("Factory Beacon Management", function () {
    let orionConfig: OrionConfig;
    let vaultFactory: TransparentVaultFactory;
    let vaultBeacon: UpgradeableBeacon;

    beforeEach(async function () {
      const deployed = await deployUpgradeableProtocol(owner, admin);
      orionConfig = deployed.orionConfig;
      vaultFactory = deployed.transparentVaultFactory;
      vaultBeacon = deployed.vaultBeacon;

      // Whitelist vault owner
      const isWhitelisted = await orionConfig.isWhitelistedVaultOwner(owner.address);
      if (!isWhitelisted) {
        await orionConfig.connect(owner).addWhitelistedVaultOwner(owner.address);
      }
    });

    it("Should create vaults with different implementations after setVaultBeacon", async function () {
      // Deploy first vault with V1 implementation
      const tx1 = await vaultFactory
        .connect(owner)
        .createVault(manager.address, "Vault V1", "VV1", 0, 0, 0, ethers.ZeroAddress);
      const receipt1 = await tx1.wait();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vault1Address = (receipt1?.logs.find((log: any) => log.fragment?.name === "OrionVaultCreated") as any)
        ?.args?.[0];

      // Get V1 implementation
      const v1Implementation = await vaultBeacon.implementation();

      // Deploy V2 implementation
      const VaultV2Factory = await ethers.getContractFactory("OrionTransparentVaultV2");
      const vaultV2Impl = await VaultV2Factory.deploy();
      await vaultV2Impl.waitForDeployment();

      // Create new beacon pointing to V2
      const BeaconFactory = await ethers.getContractFactory(
        "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon",
      );
      const newBeacon = (await BeaconFactory.deploy(
        await vaultV2Impl.getAddress(),
        owner.address,
      )) as unknown as UpgradeableBeacon;
      await newBeacon.waitForDeployment();

      // Update factory to use new beacon
      await vaultFactory.connect(owner).setVaultBeacon(await newBeacon.getAddress());

      // Deploy second vault with V2 implementation
      const tx2 = await vaultFactory
        .connect(owner)
        .createVault(manager.address, "Vault V2", "VV2", 0, 0, 0, ethers.ZeroAddress);
      const receipt2 = await tx2.wait();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vault2Address = (receipt2?.logs.find((log: any) => log.fragment?.name === "OrionVaultCreated") as any)
        ?.args?.[0];

      // Get V2 implementation from new beacon
      const v2Implementation = await newBeacon.implementation();

      // Verify implementations are different
      expect(v1Implementation).to.not.equal(v2Implementation);

      // Attach to vaults and verify versions
      const VaultV1Factory = await ethers.getContractFactory("OrionTransparentVault");
      const vault1 = VaultV1Factory.attach(vault1Address) as unknown as OrionTransparentVault;

      const vault2V2 = VaultV2Factory.attach(vault2Address) as unknown as OrionTransparentVaultV2;

      // Vault 1 should be V1 (no version function, should revert)
      // We can't call version() on V1, so just verify it's deployed correctly
      expect(await vault1.vaultOwner()).to.equal(owner.address);

      // Vault 2 should be V2
      expect(await vault2V2.version()).to.equal("v2");
      expect(await vault2V2.vaultOwner()).to.equal(owner.address);
    });

    it("Should create vaults with same new implementation after vaultBeacon.upgradeTo", async function () {
      // Deploy first vault with V1 implementation
      const tx1 = await vaultFactory
        .connect(owner)
        .createVault(manager.address, "Vault 1", "V1", 0, 0, 0, ethers.ZeroAddress);
      const receipt1 = await tx1.wait();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vault1Address = (receipt1?.logs.find((log: any) => log.fragment?.name === "OrionVaultCreated") as any)
        ?.args?.[0];

      // Deploy V2 implementation
      const VaultV2Factory = await ethers.getContractFactory("OrionTransparentVaultV2");
      const vaultV2Impl = await VaultV2Factory.deploy();
      await vaultV2Impl.waitForDeployment();

      // Upgrade existing beacon to V2
      await vaultBeacon.connect(owner).upgradeTo(await vaultV2Impl.getAddress());

      // Deploy second vault (should use V2 via upgraded beacon)
      const tx2 = await vaultFactory
        .connect(owner)
        .createVault(manager.address, "Vault 2", "V2", 0, 0, 0, ethers.ZeroAddress);
      const receipt2 = await tx2.wait();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vault2Address = (receipt2?.logs.find((log: any) => log.fragment?.name === "OrionVaultCreated") as any)
        ?.args?.[0];

      // Attach as V2 contracts
      const vault1V2 = VaultV2Factory.attach(vault1Address) as unknown as OrionTransparentVaultV2;
      const vault2V2 = VaultV2Factory.attach(vault2Address) as unknown as OrionTransparentVaultV2;

      // Both vaults should now be V2
      expect(await vault1V2.version()).to.equal("v2");
      expect(await vault2V2.version()).to.equal("v2");

      // Both vaults should have their own state
      expect(await vault1V2.vaultOwner()).to.equal(owner.address);
      expect(await vault2V2.vaultOwner()).to.equal(owner.address);

      // Test V2 functionality on both
      await vault1V2.connect(owner).setVaultDescription("Old vault, new impl");
      await vault2V2.connect(owner).setVaultDescription("New vault, new impl");

      expect(await vault1V2.vaultDescription()).to.equal("Old vault, new impl");
      expect(await vault2V2.vaultDescription()).to.equal("New vault, new impl");
    });

    it("Should maintain factory functionality after UUPS upgrade with beacon changes", async function () {
      // Deploy first vault with original factory and V1 beacon
      const tx1 = await vaultFactory
        .connect(owner)
        .createVault(manager.address, "Pre-upgrade Vault", "PRE", 0, 0, 0, ethers.ZeroAddress);
      const receipt1 = await tx1.wait();
      const vault1Event = receipt1?.logs.find((log) => {
        try {
          return vaultFactory.interface.parseLog(log)?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      const vault1Address = vault1Event ? vaultFactory.interface.parseLog(vault1Event)?.args[0] : undefined;

      // Upgrade factory via UUPS
      const FactoryFactory = await ethers.getContractFactory("TransparentVaultFactory");
      const upgradedFactory = (await upgrades.upgradeProxy(
        await vaultFactory.getAddress(),
        FactoryFactory,
      )) as unknown as TransparentVaultFactory;

      // Deploy V2 implementation
      const VaultV2Factory = await ethers.getContractFactory("OrionTransparentVaultV2");
      const vaultV2Impl = await VaultV2Factory.deploy();
      await vaultV2Impl.waitForDeployment();

      // Create new beacon pointing to V2
      const BeaconFactory = await ethers.getContractFactory(
        "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon",
      );
      const newBeacon = (await BeaconFactory.deploy(
        await vaultV2Impl.getAddress(),
        owner.address,
      )) as unknown as UpgradeableBeacon;
      await newBeacon.waitForDeployment();

      // Update upgraded factory to use new beacon
      await upgradedFactory.connect(owner).setVaultBeacon(await newBeacon.getAddress());

      // Deploy second vault with upgraded factory and V2 beacon
      const tx2 = await upgradedFactory
        .connect(owner)
        .createVault(manager.address, "Post-upgrade Vault", "POST", 0, 0, 0, ethers.ZeroAddress);
      const receipt2 = await tx2.wait();
      const vault2Event = receipt2?.logs.find((log) => {
        try {
          return upgradedFactory.interface.parseLog(log)?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      const vault2Address = vault2Event ? upgradedFactory.interface.parseLog(vault2Event)?.args[0] : undefined;

      // Attach to vaults
      const VaultV1Factory = await ethers.getContractFactory("OrionTransparentVault");
      const vault1 = VaultV1Factory.attach(vault1Address) as unknown as OrionTransparentVault;

      const vault2V2 = VaultV2Factory.attach(vault2Address) as unknown as OrionTransparentVaultV2;

      // Vault 1 should still be V1 (no version function)
      // We can't call version() on V1, so just verify it's deployed correctly
      expect(await vault1.vaultOwner()).to.equal(owner.address);

      // Vault 2 should be V2
      expect(await vault2V2.version()).to.equal("v2");
      expect(await vault2V2.vaultOwner()).to.equal(owner.address);

      // Test V2 functionality
      await vault2V2.connect(owner).setVaultDescription("Created via upgraded factory");
      expect(await vault2V2.vaultDescription()).to.equal("Created via upgraded factory");
    });
  });

  describe("Direct upgradeToAndCall", function () {
    let orionConfig: OrionConfig;
    let priceAdapterRegistry: PriceAdapterRegistry;
    let internalStatesOrchestrator: InternalStatesOrchestrator;
    let liquidityOrchestrator: LiquidityOrchestrator;
    let transparentVaultFactory: TransparentVaultFactory;

    beforeEach(async function () {
      const deployed = await deployUpgradeableProtocol(owner, admin);
      orionConfig = deployed.orionConfig;
      priceAdapterRegistry = deployed.priceAdapterRegistry;
      internalStatesOrchestrator = deployed.internalStatesOrchestrator;
      liquidityOrchestrator = deployed.liquidityOrchestrator;
      transparentVaultFactory = deployed.transparentVaultFactory;
    });

    it("Should cover OrionConfig._authorizeUpgrade via direct upgradeToAndCall", async function () {
      const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
      const newImpl = await OrionConfigFactory.deploy();
      await newImpl.waitForDeployment();

      // Call upgradeToAndCall directly, executing _authorizeUpgrade
      await orionConfig.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");

      expect(await orionConfig.owner()).to.equal(owner.address);
    });

    it("Should cover OrionConfig._authorizeUpgrade revert on non-owner", async function () {
      const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
      const newImpl = await OrionConfigFactory.deploy();
      await newImpl.waitForDeployment();

      // Non-owner should fail
      await expect(
        orionConfig.connect(user).upgradeToAndCall(await newImpl.getAddress(), "0x"),
      ).to.be.revertedWithCustomError(orionConfig, "OwnableUnauthorizedAccount");
    });

    it("Should cover PriceAdapterRegistry._authorizeUpgrade via direct upgradeToAndCall", async function () {
      const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
      const newImpl = await PriceAdapterRegistryFactory.deploy();
      await newImpl.waitForDeployment();

      // Call upgradeToAndCall directly, executing _authorizeUpgrade
      await priceAdapterRegistry.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");

      expect(await priceAdapterRegistry.owner()).to.equal(owner.address);
    });

    it("Should cover PriceAdapterRegistry._authorizeUpgrade revert on non-owner", async function () {
      const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
      const newImpl = await PriceAdapterRegistryFactory.deploy();
      await newImpl.waitForDeployment();

      await expect(
        priceAdapterRegistry.connect(user).upgradeToAndCall(await newImpl.getAddress(), "0x"),
      ).to.be.revertedWithCustomError(priceAdapterRegistry, "OwnableUnauthorizedAccount");
    });

    it("Should cover InternalStatesOrchestrator._authorizeUpgrade via direct upgradeToAndCall", async function () {
      const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
      const newImpl = await InternalStatesOrchestratorFactory.deploy();
      await newImpl.waitForDeployment();

      // Call upgradeToAndCall directly, executing _authorizeUpgrade
      await internalStatesOrchestrator.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");

      expect(await internalStatesOrchestrator.owner()).to.equal(owner.address);
    });

    it("Should cover InternalStatesOrchestrator._authorizeUpgrade revert on non-owner", async function () {
      const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
      const newImpl = await InternalStatesOrchestratorFactory.deploy();
      await newImpl.waitForDeployment();

      await expect(
        internalStatesOrchestrator.connect(user).upgradeToAndCall(await newImpl.getAddress(), "0x"),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "OwnableUnauthorizedAccount");
    });

    it("Should cover LiquidityOrchestrator._authorizeUpgrade via direct upgradeToAndCall", async function () {
      const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
      const newImpl = await LiquidityOrchestratorFactory.deploy();
      await newImpl.waitForDeployment();

      // Call upgradeToAndCall directly, executing _authorizeUpgrade
      await liquidityOrchestrator.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");

      expect(await liquidityOrchestrator.owner()).to.equal(owner.address);
    });

    it("Should cover LiquidityOrchestrator._authorizeUpgrade revert on non-owner", async function () {
      const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
      const newImpl = await LiquidityOrchestratorFactory.deploy();
      await newImpl.waitForDeployment();

      await expect(
        liquidityOrchestrator.connect(user).upgradeToAndCall(await newImpl.getAddress(), "0x"),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "OwnableUnauthorizedAccount");
    });

    it("Should cover TransparentVaultFactory._authorizeUpgrade via direct upgradeToAndCall", async function () {
      const TransparentVaultFactoryFactory = await ethers.getContractFactory("TransparentVaultFactory");
      const newImpl = await TransparentVaultFactoryFactory.deploy();
      await newImpl.waitForDeployment();

      // Call upgradeToAndCall directly, executing _authorizeUpgrade
      await transparentVaultFactory.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x");

      expect(await transparentVaultFactory.owner()).to.equal(owner.address);
    });

    it("Should cover TransparentVaultFactory._authorizeUpgrade revert on non-owner", async function () {
      const TransparentVaultFactoryFactory = await ethers.getContractFactory("TransparentVaultFactory");
      const newImpl = await TransparentVaultFactoryFactory.deploy();
      await newImpl.waitForDeployment();

      await expect(
        transparentVaultFactory.connect(user).upgradeToAndCall(await newImpl.getAddress(), "0x"),
      ).to.be.revertedWithCustomError(transparentVaultFactory, "OwnableUnauthorizedAccount");
    });
  });
});
