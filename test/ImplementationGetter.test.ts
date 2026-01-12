import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { OrionConfig, OrionTransparentVault, TransparentVaultFactory, UpgradeableBeacon } from "../typechain-types";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";

describe("Implementation Getter Tests", function () {
  let owner: SignerWithAddress;
  let strategist: SignerWithAddress;

  beforeEach(async function () {
    [owner, strategist] = await ethers.getSigners();
  });

  describe("implementation() function", function () {
    let orionConfig: OrionConfig;
    let vaultFactory: TransparentVaultFactory;
    let vaultBeacon: UpgradeableBeacon;
    let vault: OrionTransparentVault;
    let vaultAddress: string;

    beforeEach(async function () {
      // Deploy the full protocol
      const deployed = await deployUpgradeableProtocol(owner);
      orionConfig = deployed.orionConfig;
      vaultFactory = deployed.transparentVaultFactory;
      vaultBeacon = deployed.vaultBeacon;

      // Whitelist vault owner
      const isWhitelisted = await orionConfig.isWhitelistedManager(owner.address);
      if (!isWhitelisted) {
        await orionConfig.connect(owner).addWhitelistedManager(owner.address);
      }

      // Create a vault from the factory
      const tx = await vaultFactory
        .connect(owner)
        .createVault(strategist.address, "Test Vault", "TV", 0, 0, 0, ethers.ZeroAddress);
      const receipt = await tx.wait();

      // Extract vault address from event
      const event = receipt?.logs.find((log) => {
        try {
          return vaultFactory.interface.parseLog(log)?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      vaultAddress = event ? vaultFactory.interface.parseLog(event)?.args[0] : ethers.ZeroAddress;

      // Attach to the vault
      const VaultFactory = await ethers.getContractFactory("OrionTransparentVault");
      vault = VaultFactory.attach(vaultAddress) as unknown as OrionTransparentVault;
    });

    it("Should successfully call implementation() and return a valid address", async function () {
      const implementationAddress = await vault.implementation();

      expect(implementationAddress).to.not.equal(ethers.ZeroAddress);
      expect(implementationAddress).to.be.a("string");
      expect(ethers.isAddress(implementationAddress)).to.be.true;

      const beaconImplementation = await vaultBeacon.implementation();
      expect(implementationAddress).to.equal(beaconImplementation);
    });

    it("Should return the correct implementation address after vault deployment", async function () {
      const expectedImplementation = await vaultBeacon.implementation();
      const actualImplementation = await vault.implementation();
      expect(actualImplementation).to.equal(expectedImplementation);
    });

    it("Should return a different implementation address after beacon upgrade", async function () {
      const initialImplementation = await vault.implementation();
      expect(initialImplementation).to.not.equal(ethers.ZeroAddress);

      const VaultV2Factory = await ethers.getContractFactory("OrionTransparentVault");
      const vaultV2Impl = await VaultV2Factory.deploy();
      await vaultV2Impl.waitForDeployment();
      const vaultV2ImplAddress = await vaultV2Impl.getAddress();

      expect(vaultV2ImplAddress).to.not.equal(initialImplementation);

      await vaultBeacon.connect(owner).upgradeTo(vaultV2ImplAddress);

      const newBeaconImplementation = await vaultBeacon.implementation();
      expect(newBeaconImplementation).to.equal(vaultV2ImplAddress);
      expect(newBeaconImplementation).to.not.equal(initialImplementation);

      const newImplementation = await (vault as any).implementation();
      expect(newImplementation).to.equal(vaultV2ImplAddress);
      expect(newImplementation).to.not.equal(initialImplementation);
      expect(newImplementation).to.not.equal(ethers.ZeroAddress);
    });

    it("Should return valid but different values before and after upgrade", async function () {
      const beforeUpgrade = await vault.implementation();
      expect(beforeUpgrade).to.not.equal(ethers.ZeroAddress);

      const VaultV2Factory = await ethers.getContractFactory("OrionTransparentVault");
      const vaultV2Impl = await VaultV2Factory.deploy();
      await vaultV2Impl.waitForDeployment();
      const vaultV2ImplAddress = await vaultV2Impl.getAddress();

      await vaultBeacon.connect(owner).upgradeTo(vaultV2ImplAddress);

      const afterUpgrade = await vault.implementation();
      expect(afterUpgrade).to.not.equal(ethers.ZeroAddress);

      expect(beforeUpgrade).to.not.equal(afterUpgrade);
      expect(ethers.isAddress(beforeUpgrade)).to.be.true;
      expect(ethers.isAddress(afterUpgrade)).to.be.true;
      expect(afterUpgrade).to.equal(vaultV2ImplAddress);
    });

    it("Should work correctly with multiple vaults sharing the same beacon", async function () {
      const vault1Implementation = await vault.implementation();

      const tx2 = await vaultFactory
        .connect(owner)
        .createVault(strategist.address, "Test Vault 2", "TV2", 0, 0, 0, ethers.ZeroAddress);
      const receipt2 = await tx2.wait();

      const event2 = receipt2?.logs.find((log) => {
        try {
          return vaultFactory.interface.parseLog(log)?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      const vault2Address = event2 ? vaultFactory.interface.parseLog(event2)?.args[0] : ethers.ZeroAddress;

      const VaultFactory = await ethers.getContractFactory("OrionTransparentVault");
      const vault2 = VaultFactory.attach(vault2Address) as unknown as OrionTransparentVault;

      const vault2Implementation = await vault2.implementation();
      expect(vault1Implementation).to.equal(vault2Implementation);

      const VaultV2Factory = await ethers.getContractFactory("OrionTransparentVault");
      const vaultV2Impl = await VaultV2Factory.deploy();
      await vaultV2Impl.waitForDeployment();
      const vaultV2ImplAddress = await vaultV2Impl.getAddress();

      await vaultBeacon.connect(owner).upgradeTo(vaultV2ImplAddress);

      const vault1NewImpl = await vault.implementation();
      const vault2NewImpl = await vault2.implementation();

      expect(vault1NewImpl).to.equal(vaultV2ImplAddress);
      expect(vault2NewImpl).to.equal(vaultV2ImplAddress);
      expect(vault1NewImpl).to.equal(vault2NewImpl);
      expect(vault1NewImpl).to.not.equal(vault1Implementation);
    });
  });
});
