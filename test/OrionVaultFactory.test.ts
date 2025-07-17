import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { Log } from "ethers";
import { ethers } from "hardhat";

import { MockUnderlyingAsset, OrionConfig, OrionVaultFactory, VaultImplementations } from "../typechain-types";

let orionVaultFactory: OrionVaultFactory;
let orionConfig: OrionConfig;
let vaultImplementations: VaultImplementations;
let underlyingAsset: MockUnderlyingAsset;

let owner: SignerWithAddress, curator: SignerWithAddress, other: SignerWithAddress;

const ZERO_ADDRESS = ethers.ZeroAddress;

const VaultType = { Transparent: 0, Encrypted: 1 };

beforeEach(async function () {
  [owner, curator, other] = await ethers.getSigners();

  const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
  underlyingAsset = await MockUnderlyingAssetFactory.deploy(6);
  await underlyingAsset.waitForDeployment();

  const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
  orionConfig = await OrionConfigFactory.deploy();
  await orionConfig.waitForDeployment();
  await orionConfig.initialize(owner.address);

  const OrionVaultFactoryFactory = await ethers.getContractFactory("OrionVaultFactory");
  const factoryInstance = await OrionVaultFactoryFactory.deploy();
  await factoryInstance.waitForDeployment();
  await factoryInstance.initialize(owner.address, await orionConfig.getAddress());
  orionVaultFactory = await ethers.getContractAt("OrionVaultFactory", await factoryInstance.getAddress());

  await orionConfig.setProtocolParams(
    await underlyingAsset.getAddress(),
    other.address, // internalStatesOrchestrator
    other.address, // liquidityOrchestrator
    6, // curatorIntentDecimals
    await orionVaultFactory.getAddress(), // factory
    other.address, // oracleRegistry
  );

  const VaultImplementationsFactory = await ethers.getContractFactory("VaultImplementations");
  vaultImplementations = await VaultImplementationsFactory.deploy();
  await vaultImplementations.waitForDeployment();
});

describe("OrionVaultFactory", function () {
  describe("Initialization", function () {
    it("Should initialize with correct parameters", async function () {
      expect(await orionVaultFactory.owner()).to.equal(owner.address);
      expect(await orionVaultFactory.deployer()).to.equal(owner.address);
      expect(await orionVaultFactory.config()).to.equal(await orionConfig.getAddress());
      expect(await orionVaultFactory.transparentVaultImplementation()).to.equal(ZERO_ADDRESS);
      expect(await orionVaultFactory.encryptedVaultImplementation()).to.equal(ZERO_ADDRESS);
    });

    it("Should revert if initialized twice", async function () {
      await expect(
        orionVaultFactory.initialize(owner.address, await orionConfig.getAddress()),
      ).to.be.revertedWithCustomError(orionVaultFactory, "InvalidInitialization");
    });

    it("Should set deployer correctly", async function () {
      expect(await orionVaultFactory.deployer()).to.equal(owner.address);
    });
  });

  describe("Access Control", function () {
    it("Should only allow owner to set implementations", async function () {
      const transparentImpl = await vaultImplementations.TRANSPARENT_VAULT_IMPLEMENTATION();
      const encryptedImpl = await vaultImplementations.ENCRYPTED_VAULT_IMPLEMENTATION();

      await expect(
        orionVaultFactory.connect(other).setImplementations(transparentImpl, encryptedImpl),
      ).to.be.revertedWithCustomError(orionVaultFactory, "OwnableUnauthorizedAccount");
    });

    it("Should only allow owner to update config", async function () {
      await expect(
        orionVaultFactory.connect(other).updateConfig(await orionConfig.getAddress()),
      ).to.be.revertedWithCustomError(orionVaultFactory, "OwnableUnauthorizedAccount");
    });
  });

  describe("Setting Implementations", function () {
    it("Should set implementations successfully", async function () {
      const transparentImpl = await vaultImplementations.TRANSPARENT_VAULT_IMPLEMENTATION();
      const encryptedImpl = await vaultImplementations.ENCRYPTED_VAULT_IMPLEMENTATION();

      await orionVaultFactory.connect(owner).setImplementations(transparentImpl, encryptedImpl);

      expect(await orionVaultFactory.transparentVaultImplementation()).to.equal(transparentImpl);
      expect(await orionVaultFactory.encryptedVaultImplementation()).to.equal(encryptedImpl);
    });

    it("Should revert if transparent implementation is zero address", async function () {
      const encryptedImpl = await vaultImplementations.ENCRYPTED_VAULT_IMPLEMENTATION();

      await expect(
        orionVaultFactory.connect(owner).setImplementations(ZERO_ADDRESS, encryptedImpl),
      ).to.be.revertedWithCustomError(orionVaultFactory, "ZeroAddress");
    });

    it("Should revert if encrypted implementation is zero address", async function () {
      const transparentImpl = await vaultImplementations.TRANSPARENT_VAULT_IMPLEMENTATION();

      await expect(
        orionVaultFactory.connect(owner).setImplementations(transparentImpl, ZERO_ADDRESS),
      ).to.be.revertedWithCustomError(orionVaultFactory, "ZeroAddress");
    });

    it("Should handle the deploy script scenario correctly", async function () {
      // This test simulates the exact scenario from deploy-orion-vault-factory.ts
      const transparentImpl = await vaultImplementations.TRANSPARENT_VAULT_IMPLEMENTATION();
      const encryptedImpl = await vaultImplementations.ENCRYPTED_VAULT_IMPLEMENTATION();

      // Verify the owner (as done in deploy script)
      const factoryOwner = await orionVaultFactory.owner();
      expect(factoryOwner.toLowerCase()).to.equal(owner.address.toLowerCase());

      // Set implementations (as done in deploy script)
      const tx = await orionVaultFactory.connect(owner).setImplementations(transparentImpl, encryptedImpl);
      await tx.wait();

      // Verify implementations were set
      expect(await orionVaultFactory.transparentVaultImplementation()).to.equal(transparentImpl);
      expect(await orionVaultFactory.encryptedVaultImplementation()).to.equal(encryptedImpl);
    });
  });

  describe("Creating Transparent Vaults", function () {
    beforeEach(async function () {
      const transparentImpl = await vaultImplementations.TRANSPARENT_VAULT_IMPLEMENTATION();
      const encryptedImpl = await vaultImplementations.ENCRYPTED_VAULT_IMPLEMENTATION();
      await orionVaultFactory.connect(owner).setImplementations(transparentImpl, encryptedImpl);
    });

    it("Should create transparent vault successfully", async function () {
      const vaultName = "Test Transparent Vault";
      const vaultSymbol = "TTV";

      const tx = await orionVaultFactory
        .connect(owner)
        .createOrionTransparentVault(curator.address, vaultName, vaultSymbol);

      const receipt = await tx.wait();
      const event = receipt.logs.find((log: Log) => {
        try {
          const decoded = orionVaultFactory.interface.parseLog(log);
          return decoded.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });

      await expect(event).to.not.be.undefined;
      const decodedEvent = orionVaultFactory.interface.parseLog(event!);
      expect(decodedEvent.args.curator).to.equal(curator.address);
      expect(decodedEvent.args.deployer).to.equal(owner.address);
      expect(decodedEvent.args.vaultType).to.equal(VaultType.Transparent);

      const vaultAddress = decodedEvent.args.vault;
      const vault = await ethers.getContractAt("OrionTransparentVault", vaultAddress);
      expect(await vault.name()).to.equal(vaultName);
      expect(await vault.symbol()).to.equal(vaultSymbol);
      expect(await vault.curator()).to.equal(curator.address);
    });

    it("Should revert if curator is zero address", async function () {
      await expect(
        orionVaultFactory.connect(owner).createOrionTransparentVault(ZERO_ADDRESS, "Test Vault", "TV"),
      ).to.be.revertedWithCustomError(orionVaultFactory, "ZeroAddress");
    });

    it("Should revert if transparent implementation is not set", async function () {
      const newFactory = await ethers.getContractFactory("OrionVaultFactory");
      const newFactoryInstance = await newFactory.deploy();
      await newFactoryInstance.waitForDeployment();
      await newFactoryInstance.initialize(owner.address, await orionConfig.getAddress());
      const newFactoryTyped = await ethers.getContractAt("OrionVaultFactory", await newFactoryInstance.getAddress());

      await expect(
        newFactoryTyped.connect(owner).createOrionTransparentVault(curator.address, "Test Vault", "TV"),
      ).to.be.revertedWithCustomError(newFactoryTyped, "ZeroAddress");
    });
  });

  describe("Creating Encrypted Vaults", function () {
    beforeEach(async function () {
      const transparentImpl = await vaultImplementations.TRANSPARENT_VAULT_IMPLEMENTATION();
      const encryptedImpl = await vaultImplementations.ENCRYPTED_VAULT_IMPLEMENTATION();
      await orionVaultFactory.connect(owner).setImplementations(transparentImpl, encryptedImpl);
    });

    it("Should create encrypted vault successfully", async function () {
      const vaultName = "Test Encrypted Vault";
      const vaultSymbol = "TEV";

      const tx = await orionVaultFactory
        .connect(owner)
        .createOrionEncryptedVault(curator.address, vaultName, vaultSymbol);

      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: Log) => {
        try {
          const decoded = orionVaultFactory.interface.parseLog(log);
          return decoded.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });

      await expect(event).to.not.be.undefined;
      const decodedEvent = orionVaultFactory.interface.parseLog(event!);
      expect(decodedEvent.args.curator).to.equal(curator.address);
      expect(decodedEvent.args.deployer).to.equal(owner.address);
      expect(decodedEvent.args.vaultType).to.equal(VaultType.Encrypted);

      // Verify the vault was created with correct parameters
      const vaultAddress = decodedEvent.args.vault;
      const vault = await ethers.getContractAt("OrionEncryptedVault", vaultAddress);
      expect(await vault.name()).to.equal(vaultName);
      expect(await vault.symbol()).to.equal(vaultSymbol);
      expect(await vault.curator()).to.equal(curator.address);
    });

    it("Should revert if curator is zero address", async function () {
      await expect(
        orionVaultFactory.connect(owner).createOrionEncryptedVault(ZERO_ADDRESS, "Test Vault", "TV"),
      ).to.be.revertedWithCustomError(orionVaultFactory, "ZeroAddress");
    });

    it("Should revert if encrypted implementation is not set", async function () {
      const newFactory = await ethers.getContractFactory("OrionVaultFactory");
      const newFactoryInstance = await newFactory.deploy();
      await newFactoryInstance.waitForDeployment();
      await newFactoryInstance.initialize(owner.address, await orionConfig.getAddress());
      const newFactoryTyped = await ethers.getContractAt("OrionVaultFactory", await newFactoryInstance.getAddress());

      await expect(
        newFactoryTyped.connect(owner).createOrionEncryptedVault(curator.address, "Test Vault", "TV"),
      ).to.be.revertedWithCustomError(newFactoryTyped, "ZeroAddress");
    });
  });

  describe("Config Integration", function () {
    beforeEach(async function () {
      const transparentImpl = await vaultImplementations.TRANSPARENT_VAULT_IMPLEMENTATION();
      const encryptedImpl = await vaultImplementations.ENCRYPTED_VAULT_IMPLEMENTATION();
      await orionVaultFactory.connect(owner).setImplementations(transparentImpl, encryptedImpl);
    });

    it("Should update config successfully", async function () {
      const newConfig = await ethers.getContractFactory("OrionConfig");
      const newConfigInstance = await newConfig.deploy();
      await newConfigInstance.waitForDeployment();
      await newConfigInstance.initialize(owner.address);

      await orionVaultFactory.connect(owner).updateConfig(await newConfigInstance.getAddress());
      expect(await orionVaultFactory.config()).to.equal(await newConfigInstance.getAddress());
    });

    it("Should call addOrionVault on config when creating vaults", async function () {
      const tx = await orionVaultFactory
        .connect(owner)
        .createOrionTransparentVault(curator.address, "Test Vault", "TV");

      await expect(tx).to.not.be.reverted;
    });
  });
});
