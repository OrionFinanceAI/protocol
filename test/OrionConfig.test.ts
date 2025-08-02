import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, upgrades } from "hardhat";

import { MockUnderlyingAsset, OrionConfig } from "../typechain-types";

let OrionConfig: OrionConfig;
let orionConfig: OrionConfig;
let owner: SignerWithAddress,
  vaultFactory: SignerWithAddress,
  other: SignerWithAddress,
  addr1: SignerWithAddress,
  addr2: SignerWithAddress;
let underlyingAsset: MockUnderlyingAsset;

const ZERO = ethers.ZeroAddress;

// VaultType enum as per EventsLib (assuming Encrypted=0, Transparent=1)
const VaultType = { Encrypted: 0, Transparent: 1 };

beforeEach(async function () {
  [owner, vaultFactory, other, addr1, addr2] = await ethers.getSigners();

  // Deploy MockUnderlyingAsset
  const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
  underlyingAsset = await MockUnderlyingAssetFactory.deploy(6);
  await underlyingAsset.waitForDeployment();

  // Deploy OrionConfig and initialize
  const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
  orionConfig = await OrionConfigFactory.deploy();
  await orionConfig.waitForDeployment();

  await orionConfig.initialize(owner.address);
});

describe("OrionConfig", function () {
  describe("initialize", function () {
    it("sets owner correctly", async function () {
      expect(await orionConfig.owner()).to.equal(owner.address);
    });

    it("cannot initialize twice", async function () {
      await expect(orionConfig.initialize(owner.address)).to.be.revertedWithCustomError(
        orionConfig,
        "InvalidInitialization",
      );
    });
  });

  describe("setProtocolParams", function () {
    it("reverts if underlyingAsset is zero", async function () {
      await expect(orionConfig.connect(owner).setUnderlyingAsset(ZERO)).to.be.revertedWithCustomError(
        orionConfig,
        "ZeroAddress",
      );
    });

    it("reverts if internalStatesOrchestrator is zero", async function () {
      await expect(orionConfig.connect(owner).setInternalStatesOrchestrator(ZERO)).to.be.revertedWithCustomError(
        orionConfig,
        "ZeroAddress",
      );
    });

    it("reverts if liquidityOrchestrator is zero", async function () {
      await expect(
        orionConfig.connect(owner).setProtocolParams(ZERO, 8, vaultFactory.address, other.address),
      ).to.be.revertedWithCustomError(orionConfig, "ZeroAddress");
    });

    it("reverts if factory is zero", async function () {
      await expect(
        orionConfig.connect(owner).setProtocolParams(other.address, 8, ZERO, other.address),
      ).to.be.revertedWithCustomError(orionConfig, "ZeroAddress");
    });

    it("reverts if priceAdapterRegistry is zero", async function () {
      await expect(
        orionConfig.connect(owner).setProtocolParams(other.address, 8, vaultFactory.address, ZERO),
      ).to.be.revertedWithCustomError(orionConfig, "ZeroAddress");
    });

    it("sets all params and emits event", async function () {
      await orionConfig.connect(owner).setUnderlyingAsset(underlyingAsset.target);
      await orionConfig.connect(owner).setInternalStatesOrchestrator(other.address);

      await expect(
        orionConfig.connect(owner).setProtocolParams(vaultFactory.address, 6, vaultFactory.address, other.address),
      ).to.emit(orionConfig, "ProtocolParamsUpdated");

      expect(await orionConfig.underlyingAsset()).to.equal(underlyingAsset.target);
      expect(await orionConfig.internalStatesOrchestrator()).to.equal(other.address);
      expect(await orionConfig.liquidityOrchestrator()).to.equal(vaultFactory.address);
      expect(await orionConfig.curatorIntentDecimals()).to.equal(6);
      expect(await orionConfig.vaultFactory()).to.equal(vaultFactory.address);
      expect(await orionConfig.priceAdapterRegistry()).to.equal(other.address);
    });

    it("only owner can call setProtocolParams", async function () {
      await expect(
        orionConfig.connect(other).setProtocolParams(vaultFactory.address, 6, vaultFactory.address, other.address),
      ).to.be.revertedWithCustomError(orionConfig, "OwnableUnauthorizedAccount");
    });
  });

  describe("Orion vaults management", function () {
    it("only factory can add/remove vaults", async function () {
      await expect(
        orionConfig.connect(other).addOrionVault(addr1.address, VaultType.Encrypted),
      ).to.be.revertedWithCustomError(orionConfig, "NotFactory");

      await orionConfig.connect(owner).setProtocolParams(vaultFactory.address, 6, vaultFactory.address, other.address);

      // factory can add vault
      await orionConfig.connect(vaultFactory).addOrionVault(addr1.address, VaultType.Encrypted);

      // others can't remove vault
      await expect(
        orionConfig.connect(other).removeOrionVault(addr1.address, VaultType.Encrypted),
      ).to.be.revertedWithCustomError(orionConfig, "NotFactory");

      // factory can remove vault
      await orionConfig.connect(vaultFactory).removeOrionVault(addr1.address, VaultType.Encrypted);
    });

    it("reverts adding zero address vault", async function () {
      await orionConfig.connect(owner).setProtocolParams(vaultFactory.address, 6, vaultFactory.address, other.address);

      await expect(
        orionConfig.connect(vaultFactory).addOrionVault(ZERO, VaultType.Encrypted),
      ).to.be.revertedWithCustomError(orionConfig, "ZeroAddress");
    });

    it("reverts adding existing vault", async function () {
      await orionConfig.connect(owner).setProtocolParams(vaultFactory.address, 6, vaultFactory.address, other.address);

      await orionConfig.connect(vaultFactory).addOrionVault(addr1.address, VaultType.Encrypted);

      await expect(
        orionConfig.connect(vaultFactory).addOrionVault(addr1.address, VaultType.Encrypted),
      ).to.be.revertedWithCustomError(orionConfig, "AlreadyAnOrionVault");
    });

    it("reverts removing vault not added", async function () {
      await orionConfig.connect(owner).setProtocolParams(vaultFactory.address, 6, vaultFactory.address, other.address);

      await expect(
        orionConfig.connect(vaultFactory).removeOrionVault(addr1.address, VaultType.Encrypted),
      ).to.be.revertedWithCustomError(orionConfig, "NotAnOrionVault");
    });

    it("adds/removes both Encrypted and Transparent vaults correctly and emits events", async function () {
      await orionConfig.connect(owner).setProtocolParams(vaultFactory.address, 6, vaultFactory.address, other.address);

      await expect(orionConfig.connect(vaultFactory).addOrionVault(addr1.address, VaultType.Encrypted))
        .to.emit(orionConfig, "OrionVaultAdded")
        .withArgs(addr1.address);

      await expect(orionConfig.connect(vaultFactory).addOrionVault(addr2.address, VaultType.Transparent))
        .to.emit(orionConfig, "OrionVaultAdded")
        .withArgs(addr2.address);

      expect(await orionConfig.getAllOrionVaults(VaultType.Encrypted)).to.include(addr1.address);
      expect(await orionConfig.getAllOrionVaults(VaultType.Transparent)).to.include(addr2.address);

      await expect(orionConfig.connect(vaultFactory).removeOrionVault(addr1.address, VaultType.Encrypted))
        .to.emit(orionConfig, "OrionVaultRemoved")
        .withArgs(addr1.address);

      await expect(orionConfig.connect(vaultFactory).removeOrionVault(addr2.address, VaultType.Transparent))
        .to.emit(orionConfig, "OrionVaultRemoved")
        .withArgs(addr2.address);
    });
  });

  describe("OrionConfig UUPS upgradeability", function () {
    let orionConfigProxy: OrionConfig;

    beforeEach(async function () {
      OrionConfig = await ethers.getContractFactory("OrionConfig");
      // Deploy behind a UUPS proxy
      orionConfigProxy = await upgrades.deployProxy(OrionConfig, [owner.address], {
        kind: "uups",
        initializer: "initialize",
      });
      await orionConfigProxy.waitForDeployment();
    });
  });
});
