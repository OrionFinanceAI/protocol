import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  MockUnderlyingAsset,
  OrionConfig,
  TransparentVaultFactory,
  OrionTransparentVault,
  WhitelistAccessControl,
  PriceAdapterRegistry,
} from "../typechain-types";

describe("Access Control", function () {
  let owner: SignerWithAddress;
  let curator: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let user3: SignerWithAddress;

  let mockAsset: MockUnderlyingAsset;
  let orionConfig: OrionConfig;
  let factory: TransparentVaultFactory;
  let priceAdapterRegistry: PriceAdapterRegistry;
  let internalStatesOrchestrator;
  let liquidityOrchestrator;
  let accessControl: WhitelistAccessControl;

  const DEPOSIT_AMOUNT = ethers.parseUnits("1000", 6);

  beforeEach(async function () {
    [owner, curator, user1, user2, user3] = await ethers.getSigners();

    // Deploy mock underlying asset (USDC-like, 6 decimals)
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    mockAsset = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset;

    // Deploy OrionConfig
    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    orionConfig = (await OrionConfigFactory.deploy(
      owner.address,
      owner.address,
      await mockAsset.getAddress(),
    )) as unknown as OrionConfig;

    // Deploy Orchestrators
    const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
    internalStatesOrchestrator = await InternalStatesOrchestratorFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
      owner.address,
    );

    const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
    liquidityOrchestrator = await LiquidityOrchestratorFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
      owner.address,
    );

    // Deploy PriceAdapterRegistry
    const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
    priceAdapterRegistry = (await PriceAdapterRegistryFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
    )) as unknown as PriceAdapterRegistry;

    // Deploy TransparentVaultFactory
    const TransparentVaultFactoryFactory = await ethers.getContractFactory("TransparentVaultFactory");
    factory = (await TransparentVaultFactoryFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as TransparentVaultFactory;

    // Configure OrionConfig
    await orionConfig.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());
    await orionConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());
    await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());
    await orionConfig.setVaultFactory(await factory.getAddress());

    // Whitelist curator (owner is already whitelisted in constructor)
    await orionConfig.addWhitelistedCurator(curator.address);

    // Deploy WhitelistAccessControl
    const WhitelistAccessControlFactory = await ethers.getContractFactory("WhitelistAccessControl");
    accessControl = (await WhitelistAccessControlFactory.deploy(owner.address)) as unknown as WhitelistAccessControl;
  });

  describe("Permissionless Mode (address(0))", function () {
    let vault: OrionTransparentVault;

    beforeEach(async function () {
      // Create vault with no access control (permissionless)
      const tx = await factory.createVault(
        curator.address,
        "Test Vault",
        "TVAULT",
        0, // feeType
        0, // performanceFee
        0, // managementFee
        ethers.ZeroAddress, // depositAccessControl = address(0)
      );

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = factory.interface.parseLog(log);
          return parsed?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });

      const parsedEvent = factory.interface.parseLog(event!);
      const vaultAddress = parsedEvent?.args[0];

      vault = (await ethers.getContractAt("OrionTransparentVault", vaultAddress)) as unknown as OrionTransparentVault;
    });

    it("Should allow any user to deposit when access control is zero address", async function () {
      // Mint tokens to users
      await mockAsset.mint(user1.address, DEPOSIT_AMOUNT);
      await mockAsset.mint(user2.address, DEPOSIT_AMOUNT);

      // Approve vault
      await mockAsset.connect(user1).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await mockAsset.connect(user2).approve(await vault.getAddress(), DEPOSIT_AMOUNT);

      // Both users should be able to deposit
      await expect(vault.connect(user1).requestDeposit(DEPOSIT_AMOUNT)).to.not.be.reverted;

      await expect(vault.connect(user2).requestDeposit(DEPOSIT_AMOUNT)).to.not.be.reverted;
    });

    it("Should return zero address for depositAccessControl", async function () {
      expect(await vault.depositAccessControl()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("With Access Control Enabled", function () {
    let vault: OrionTransparentVault;

    beforeEach(async function () {
      // Create vault with access control
      const tx = await factory.createVault(
        curator.address,
        "Gated Vault",
        "GVAULT",
        0,
        0,
        0,
        await accessControl.getAddress(), // depositAccessControl enabled
      );

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = factory.interface.parseLog(log);
          return parsed?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });

      const parsedEvent = factory.interface.parseLog(event!);
      const vaultAddress = parsedEvent?.args[0];

      vault = (await ethers.getContractAt("OrionTransparentVault", vaultAddress)) as unknown as OrionTransparentVault;
    });

    it("Should return correct depositAccessControl address", async function () {
      expect(await vault.depositAccessControl()).to.equal(await accessControl.getAddress());
    });

    it("Should allow whitelisted user to deposit", async function () {
      // Whitelist user1
      await accessControl.addToWhitelist([user1.address]);

      // Mint and approve
      await mockAsset.mint(user1.address, DEPOSIT_AMOUNT);
      await mockAsset.connect(user1).approve(await vault.getAddress(), DEPOSIT_AMOUNT);

      // Should succeed
      await expect(vault.connect(user1).requestDeposit(DEPOSIT_AMOUNT)).to.not.be.reverted;
    });

    it("Should reject non-whitelisted user deposit", async function () {
      // user2 is not whitelisted
      await mockAsset.mint(user2.address, DEPOSIT_AMOUNT);
      await mockAsset.connect(user2).approve(await vault.getAddress(), DEPOSIT_AMOUNT);

      // Should revert
      await expect(vault.connect(user2).requestDeposit(DEPOSIT_AMOUNT)).to.be.revertedWithCustomError(
        vault,
        "DepositNotAllowed",
      );
    });

    it("Should allow owner to add users to whitelist", async function () {
      // Add user3 to whitelist
      await expect(accessControl.addToWhitelist([user3.address]))
        .to.emit(accessControl, "AddressWhitelisted")
        .withArgs(user3.address);

      // Verify user3 can deposit
      await mockAsset.mint(user3.address, DEPOSIT_AMOUNT);
      await mockAsset.connect(user3).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await expect(vault.connect(user3).requestDeposit(DEPOSIT_AMOUNT)).to.not.be.reverted;
    });

    it("Should allow owner to remove users from whitelist", async function () {
      // Whitelist then remove user1
      await accessControl.addToWhitelist([user1.address]);
      await expect(accessControl.removeFromWhitelist([user1.address]))
        .to.emit(accessControl, "AddressRemovedFromWhitelist")
        .withArgs(user1.address);

      // Verify user1 cannot deposit
      await mockAsset.mint(user1.address, DEPOSIT_AMOUNT);
      await mockAsset.connect(user1).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await expect(vault.connect(user1).requestDeposit(DEPOSIT_AMOUNT)).to.be.revertedWithCustomError(
        vault,
        "DepositNotAllowed",
      );
    });

    it("Should support batch whitelisting", async function () {
      const addresses = [user1.address, user2.address, user3.address];

      await expect(accessControl.addToWhitelist(addresses)).to.not.be.reverted;

      // Verify all can deposit
      for (const user of [user1, user2, user3]) {
        await mockAsset.mint(user.address, DEPOSIT_AMOUNT);
        await mockAsset.connect(user).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
        await expect(vault.connect(user).requestDeposit(DEPOSIT_AMOUNT)).to.not.be.reverted;
      }
    });
  });

  describe("Vault Owner Can Update Access Control", function () {
    let vault: OrionTransparentVault;

    beforeEach(async function () {
      // Create vault without access control initially
      const tx = await factory.createVault(curator.address, "Updateable Vault", "UVAULT", 0, 0, 0, ethers.ZeroAddress);

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = factory.interface.parseLog(log);
          return parsed?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });

      const parsedEvent = factory.interface.parseLog(event!);
      const vaultAddress = parsedEvent?.args[0];

      vault = (await ethers.getContractAt("OrionTransparentVault", vaultAddress)) as unknown as OrionTransparentVault;
    });

    it("Should allow vault owner to set access control", async function () {
      await expect(vault.connect(owner).setDepositAccessControl(await accessControl.getAddress()))
        .to.emit(vault, "DepositAccessControlUpdated")
        .withArgs(await accessControl.getAddress());

      expect(await vault.depositAccessControl()).to.equal(await accessControl.getAddress());
    });

    it("Should allow vault owner to disable access control", async function () {
      // First enable
      await vault.connect(owner).setDepositAccessControl(await accessControl.getAddress());

      // Then disable
      await expect(vault.connect(owner).setDepositAccessControl(ethers.ZeroAddress))
        .to.emit(vault, "DepositAccessControlUpdated")
        .withArgs(ethers.ZeroAddress);

      expect(await vault.depositAccessControl()).to.equal(ethers.ZeroAddress);
    });

    it("Should reject non-owner attempts to set access control", async function () {
      await expect(
        vault.connect(user1).setDepositAccessControl(await accessControl.getAddress()),
      ).to.be.revertedWithCustomError(vault, "NotAuthorized");
    });

    it("Should apply access control after being set", async function () {
      // Initially permissionless
      await mockAsset.mint(user1.address, DEPOSIT_AMOUNT);
      await mockAsset.connect(user1).approve(await vault.getAddress(), DEPOSIT_AMOUNT);
      await expect(vault.connect(user1).requestDeposit(DEPOSIT_AMOUNT)).to.not.be.reverted;

      // Cancel the deposit
      await vault.connect(user1).cancelDepositRequest(DEPOSIT_AMOUNT);

      // Now enable access control
      await vault.connect(owner).setDepositAccessControl(await accessControl.getAddress());

      // Approve again for next deposit attempt
      await mockAsset.connect(user1).approve(await vault.getAddress(), DEPOSIT_AMOUNT);

      // user1 is not whitelisted, should fail
      await expect(vault.connect(user1).requestDeposit(DEPOSIT_AMOUNT)).to.be.revertedWithCustomError(
        vault,
        "DepositNotAllowed",
      );

      // Whitelist user1
      await accessControl.addToWhitelist([user1.address]);

      // Now should work
      await expect(vault.connect(user1).requestDeposit(DEPOSIT_AMOUNT)).to.not.be.reverted;
    });
  });

  describe("Access Control Contract Behavior", function () {
    it("Should allow owner to transfer ownership", async function () {
      await expect(accessControl.connect(owner).transferOwnership(user1.address)).to.not.be.reverted;
      await expect(accessControl.connect(user1).acceptOwnership()).to.not.be.reverted;
      expect(await accessControl.owner()).to.equal(user1.address);
    });
  });
});
