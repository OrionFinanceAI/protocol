import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { OrionConfig, PriceAdapterRegistry, LiquidityOrchestrator, TransparentVaultFactory } from "../typechain-types";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";
import { Contract } from "ethers";

// Minimal ABI for the OZ TimelockController functions used in tests
const TIMELOCK_ABI = [
  "function schedule(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt, uint256 delay) external",
  "function execute(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt) external payable",
  "function getMinDelay() external view returns (uint256)",
  "function isOperation(bytes32 id) external view returns (bool)",
  "function isOperationReady(bytes32 id) external view returns (bool)",
  "function isOperationDone(bytes32 id) external view returns (bool)",
  "function hashOperation(address target, uint256 value, bytes calldata data, bytes32 predecessor, bytes32 salt) external pure returns (bytes32)",
];

const ZERO_BYTES32 = ethers.ZeroHash;
const SALT = ethers.id("orion.upgrade.salt.v1");
const MIN_DELAY = 2 * 24 * 60 * 60; // 2 days in seconds

/**
 * Deploy an OZ TimelockController with `proposer` as the only proposer/executor.
 * admin is set to ZeroAddress so the timelock is self-governed after deployment.
 */
async function deployTimelockController(proposer: SignerWithAddress): Promise<Contract> {
  const TimelockFactory = await ethers.getContractFactory(
    "@openzeppelin/contracts/governance/TimelockController.sol:TimelockController",
  );
  const timelock = await TimelockFactory.deploy(
    MIN_DELAY,
    [proposer.address], // proposers
    [proposer.address], // executors
    ethers.ZeroAddress, // admin (self-governed)
  );
  await timelock.waitForDeployment();
  return new Contract(await timelock.getAddress(), TIMELOCK_ABI, proposer);
}

describe("Upgrade Timelock Tests", function () {
  let owner: SignerWithAddress;
  let guardian: SignerWithAddress;
  let attacker: SignerWithAddress;

  let orionConfig: OrionConfig;
  let priceAdapterRegistry: PriceAdapterRegistry;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let transparentVaultFactory: TransparentVaultFactory;

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    [owner, guardian, attacker] = await ethers.getSigners();
    const deployed = await deployUpgradeableProtocol(owner);
    orionConfig = deployed.orionConfig;
    priceAdapterRegistry = deployed.priceAdapterRegistry;
    liquidityOrchestrator = deployed.liquidityOrchestrator;
    transparentVaultFactory = deployed.transparentVaultFactory;
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // setUpgradeTimelock — initial setter (no timelock yet)
  // ─────────────────────────────────────────────────────────────────────────────

  describe("setUpgradeTimelock – bootstrapping phase (no timelock set)", function () {
    for (const { name, get } of [
      { name: "OrionConfig", get: () => orionConfig },
      { name: "PriceAdapterRegistry", get: () => priceAdapterRegistry },
      { name: "LiquidityOrchestrator", get: () => liquidityOrchestrator },
      { name: "TransparentVaultFactory", get: () => transparentVaultFactory },
    ]) {
      it(`${name}: owner can set the timelock address`, async function () {
        const contract = get();
        expect(await contract.upgradeTimelock()).to.equal(ethers.ZeroAddress);

        await contract.connect(owner).setUpgradeTimelock(guardian.address);

        expect(await contract.upgradeTimelock()).to.equal(guardian.address);
      });

      it(`${name}: owner setting timelock emits UpgradeTimelockSet`, async function () {
        const contract = get();

        await expect(contract.connect(owner).setUpgradeTimelock(guardian.address))
          .to.emit(contract, "UpgradeTimelockSet")
          .withArgs(await contract.getAddress(), guardian.address);
      });

      it(`${name}: non-owner cannot set the initial timelock`, async function () {
        const contract = get();

        await expect(contract.connect(attacker).setUpgradeTimelock(attacker.address)).to.be.revertedWithCustomError(
          contract,
          "NotAuthorized",
        );
      });

      it(`${name}: zero address is rejected as timelock`, async function () {
        const contract = get();

        await expect(contract.connect(owner).setUpgradeTimelock(ethers.ZeroAddress)).to.be.revertedWithCustomError(
          contract,
          "ZeroAddress",
        );
      });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // setUpgradeTimelock — rotation after timelock is active
  // ─────────────────────────────────────────────────────────────────────────────

  describe("setUpgradeTimelock – rotation phase (timelock already set)", function () {
    let fakeTimelock: SignerWithAddress;
    let newTimelock: SignerWithAddress;

    beforeEach(async function () {
      [, , , fakeTimelock, newTimelock] = await ethers.getSigners();
    });

    for (const { name, get } of [
      { name: "OrionConfig", get: () => orionConfig },
      { name: "PriceAdapterRegistry", get: () => priceAdapterRegistry },
      { name: "LiquidityOrchestrator", get: () => liquidityOrchestrator },
      { name: "TransparentVaultFactory", get: () => transparentVaultFactory },
    ]) {
      it(`${name}: only the active timelock can rotate to a new timelock`, async function () {
        const contract = get();
        await contract.connect(owner).setUpgradeTimelock(fakeTimelock.address);

        await contract.connect(fakeTimelock).setUpgradeTimelock(newTimelock.address);

        expect(await contract.upgradeTimelock()).to.equal(newTimelock.address);
      });

      it(`${name}: owner cannot rotate the timelock once it is set`, async function () {
        const contract = get();
        await contract.connect(owner).setUpgradeTimelock(fakeTimelock.address);

        await expect(contract.connect(owner).setUpgradeTimelock(newTimelock.address)).to.be.revertedWithCustomError(
          contract,
          "NotAuthorized",
        );
      });

      it(`${name}: attacker cannot rotate the timelock`, async function () {
        const contract = get();
        await contract.connect(owner).setUpgradeTimelock(fakeTimelock.address);

        await expect(contract.connect(attacker).setUpgradeTimelock(attacker.address)).to.be.revertedWithCustomError(
          contract,
          "NotAuthorized",
        );
      });

      it(`${name}: timelock rotation emits UpgradeTimelockSet`, async function () {
        const contract = get();
        await contract.connect(owner).setUpgradeTimelock(fakeTimelock.address);

        await expect(contract.connect(fakeTimelock).setUpgradeTimelock(newTimelock.address))
          .to.emit(contract, "UpgradeTimelockSet")
          .withArgs(await contract.getAddress(), newTimelock.address);
      });

      it(`${name}: timelock cannot rotate to zero address`, async function () {
        const contract = get();
        await contract.connect(owner).setUpgradeTimelock(fakeTimelock.address);

        await expect(
          contract.connect(fakeTimelock).setUpgradeTimelock(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(contract, "ZeroAddress");
      });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // _authorizeUpgrade — access control on upgradeToAndCall
  // ─────────────────────────────────────────────────────────────────────────────

  describe("_authorizeUpgrade – before timelock is set (bootstrapping)", function () {
    it("OrionConfig: owner can upgrade directly before timelock is configured", async function () {
      const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
      const newImpl = await OrionConfigFactory.deploy();
      await newImpl.waitForDeployment();

      await expect(orionConfig.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x")).to.not.be.reverted;
    });

    it("OrionConfig: attacker cannot upgrade even before timelock is configured", async function () {
      const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
      const newImpl = await OrionConfigFactory.deploy();
      await newImpl.waitForDeployment();

      // _authorizeUpgrade uses our NotAuthorized error (not OZ's OwnableUnauthorizedAccount)
      await expect(
        orionConfig.connect(attacker).upgradeToAndCall(await newImpl.getAddress(), "0x"),
      ).to.be.revertedWithCustomError(orionConfig, "NotAuthorized");
    });
  });

  describe("_authorizeUpgrade – after timelock is set", function () {
    let fakeTimelock: SignerWithAddress;

    beforeEach(async function () {
      [, , , fakeTimelock] = await ethers.getSigners();
    });

    for (const { name, get, implName } of [
      { name: "OrionConfig", get: () => orionConfig, implName: "OrionConfig" },
      { name: "PriceAdapterRegistry", get: () => priceAdapterRegistry, implName: "PriceAdapterRegistry" },
      { name: "LiquidityOrchestrator", get: () => liquidityOrchestrator, implName: "LiquidityOrchestrator" },
      { name: "TransparentVaultFactory", get: () => transparentVaultFactory, implName: "TransparentVaultFactory" },
    ]) {
      it(`${name}: timelock address can trigger upgradeToAndCall`, async function () {
        const contract = get();
        await contract.connect(owner).setUpgradeTimelock(fakeTimelock.address);

        const ImplFactory = await ethers.getContractFactory(implName);
        const newImpl = await ImplFactory.deploy();
        await newImpl.waitForDeployment();

        // Fund fakeTimelock so it can send transactions
        await owner.sendTransaction({ to: fakeTimelock.address, value: ethers.parseEther("1") });

        await expect(contract.connect(fakeTimelock).upgradeToAndCall(await newImpl.getAddress(), "0x")).to.not.be
          .reverted;
      });

      it(`${name}: owner is blocked from upgradeToAndCall once timelock is set`, async function () {
        const contract = get();
        await contract.connect(owner).setUpgradeTimelock(fakeTimelock.address);

        const ImplFactory = await ethers.getContractFactory(implName);
        const newImpl = await ImplFactory.deploy();
        await newImpl.waitForDeployment();

        await expect(
          contract.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x"),
        ).to.be.revertedWithCustomError(contract, "NotAuthorized");
      });

      it(`${name}: attacker is blocked from upgradeToAndCall once timelock is set`, async function () {
        const contract = get();
        await contract.connect(owner).setUpgradeTimelock(fakeTimelock.address);

        const ImplFactory = await ethers.getContractFactory(implName);
        const newImpl = await ImplFactory.deploy();
        await newImpl.waitForDeployment();

        await expect(
          contract.connect(attacker).upgradeToAndCall(await newImpl.getAddress(), "0x"),
        ).to.be.revertedWithCustomError(contract, "NotAuthorized");
      });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // OZ TimelockController integration — full schedule → wait → execute flow
  // ─────────────────────────────────────────────────────────────────────────────

  describe("OZ TimelockController integration", function () {
    let timelock: Contract;

    beforeEach(async function () {
      timelock = await deployTimelockController(owner);
      await orionConfig.connect(owner).setUpgradeTimelock(await timelock.getAddress());
    });

    it("Should have MIN_DELAY configured on the timelock", async function () {
      expect(await timelock.getMinDelay()).to.equal(MIN_DELAY);
    });

    it("Should reject direct upgradeToAndCall from owner once OZ timelock is set", async function () {
      const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
      const newImpl = await OrionConfigFactory.deploy();
      await newImpl.waitForDeployment();

      await expect(
        orionConfig.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x"),
      ).to.be.revertedWithCustomError(orionConfig, "NotAuthorized");
    });

    it("Should schedule an upgrade operation on the timelock", async function () {
      const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
      const newImpl = await OrionConfigFactory.deploy();
      await newImpl.waitForDeployment();

      const upgradeData = orionConfig.interface.encodeFunctionData("upgradeToAndCall", [
        await newImpl.getAddress(),
        "0x",
      ]);

      await timelock.schedule(await orionConfig.getAddress(), 0, upgradeData, ZERO_BYTES32, SALT, MIN_DELAY);

      const opId = await timelock.hashOperation(await orionConfig.getAddress(), 0, upgradeData, ZERO_BYTES32, SALT);

      expect(await timelock.isOperation(opId)).to.equal(true);
      expect(await timelock.isOperationReady(opId)).to.equal(false);
    });

    it("Should revert if execute is called before the delay has elapsed", async function () {
      const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
      const newImpl = await OrionConfigFactory.deploy();
      await newImpl.waitForDeployment();

      const upgradeData = orionConfig.interface.encodeFunctionData("upgradeToAndCall", [
        await newImpl.getAddress(),
        "0x",
      ]);

      await timelock.schedule(await orionConfig.getAddress(), 0, upgradeData, ZERO_BYTES32, SALT, MIN_DELAY);

      // Try to execute immediately — should fail because delay has not elapsed
      await expect(timelock.execute(await orionConfig.getAddress(), 0, upgradeData, ZERO_BYTES32, SALT)).to.be.reverted;
    });

    it("Should execute the upgrade after the timelock delay has elapsed", async function () {
      const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
      const newImpl = await OrionConfigFactory.deploy();
      await newImpl.waitForDeployment();
      const newImplAddress = await newImpl.getAddress();

      const upgradeData = orionConfig.interface.encodeFunctionData("upgradeToAndCall", [newImplAddress, "0x"]);

      // Schedule the upgrade
      await timelock.schedule(await orionConfig.getAddress(), 0, upgradeData, ZERO_BYTES32, SALT, MIN_DELAY);

      // Fast-forward time past the delay
      await ethers.provider.send("evm_increaseTime", [MIN_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);

      const opId = await timelock.hashOperation(await orionConfig.getAddress(), 0, upgradeData, ZERO_BYTES32, SALT);
      expect(await timelock.isOperationReady(opId)).to.equal(true);

      // Execute the upgrade
      await timelock.execute(await orionConfig.getAddress(), 0, upgradeData, ZERO_BYTES32, SALT);

      expect(await timelock.isOperationDone(opId)).to.equal(true);
      // State is preserved through the upgrade
      expect(await orionConfig.owner()).to.equal(owner.address);
    });

    it("Should preserve all contract state after a timelock-gated upgrade", async function () {
      const underlyingAddress = await orionConfig.underlyingAsset();
      const registryAddress = await orionConfig.priceAdapterRegistry();
      const ownerAddress = await orionConfig.owner();

      const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
      const newImpl = await OrionConfigFactory.deploy();
      await newImpl.waitForDeployment();

      const upgradeData = orionConfig.interface.encodeFunctionData("upgradeToAndCall", [
        await newImpl.getAddress(),
        "0x",
      ]);

      await timelock.schedule(await orionConfig.getAddress(), 0, upgradeData, ZERO_BYTES32, SALT, MIN_DELAY);

      await ethers.provider.send("evm_increaseTime", [MIN_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await timelock.execute(await orionConfig.getAddress(), 0, upgradeData, ZERO_BYTES32, SALT);

      // All critical storage must survive the upgrade
      expect(await orionConfig.underlyingAsset()).to.equal(underlyingAddress);
      expect(await orionConfig.priceAdapterRegistry()).to.equal(registryAddress);
      expect(await orionConfig.owner()).to.equal(ownerAddress);
      expect(await orionConfig.upgradeTimelock()).to.equal(await timelock.getAddress());
    });

    it("Should not allow the same operation to be executed twice (replay protection)", async function () {
      const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
      const newImpl = await OrionConfigFactory.deploy();
      await newImpl.waitForDeployment();

      const upgradeData = orionConfig.interface.encodeFunctionData("upgradeToAndCall", [
        await newImpl.getAddress(),
        "0x",
      ]);

      await timelock.schedule(await orionConfig.getAddress(), 0, upgradeData, ZERO_BYTES32, SALT, MIN_DELAY);

      await ethers.provider.send("evm_increaseTime", [MIN_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await timelock.execute(await orionConfig.getAddress(), 0, upgradeData, ZERO_BYTES32, SALT);

      // Re-executing the same operation should revert
      await expect(timelock.execute(await orionConfig.getAddress(), 0, upgradeData, ZERO_BYTES32, SALT)).to.be.reverted;
    });

    it("Should allow a second upgrade using a different salt after the first succeeds", async function () {
      const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
      const impl1 = await OrionConfigFactory.deploy();
      await impl1.waitForDeployment();
      const impl2 = await OrionConfigFactory.deploy();
      await impl2.waitForDeployment();

      const SALT_2 = ethers.id("orion.upgrade.salt.v2");

      // Schedule and execute first upgrade
      const upgradeData1 = orionConfig.interface.encodeFunctionData("upgradeToAndCall", [
        await impl1.getAddress(),
        "0x",
      ]);
      await timelock.schedule(await orionConfig.getAddress(), 0, upgradeData1, ZERO_BYTES32, SALT, MIN_DELAY);
      await ethers.provider.send("evm_increaseTime", [MIN_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);
      await timelock.execute(await orionConfig.getAddress(), 0, upgradeData1, ZERO_BYTES32, SALT);

      // Schedule and execute second upgrade using a fresh salt
      const upgradeData2 = orionConfig.interface.encodeFunctionData("upgradeToAndCall", [
        await impl2.getAddress(),
        "0x",
      ]);
      await timelock.schedule(await orionConfig.getAddress(), 0, upgradeData2, ZERO_BYTES32, SALT_2, MIN_DELAY);
      await ethers.provider.send("evm_increaseTime", [MIN_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);
      await expect(timelock.execute(await orionConfig.getAddress(), 0, upgradeData2, ZERO_BYTES32, SALT_2)).to.not.be
        .reverted;

      expect(await orionConfig.owner()).to.equal(owner.address);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Timelock replacement via a second OZ TimelockController (rotation)
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Rotating to a new OZ TimelockController", function () {
    it("Should allow the active timelock to schedule rotating to a new timelock", async function () {
      const timelock1 = await deployTimelockController(owner);
      const timelock2 = await deployTimelockController(owner);

      await orionConfig.connect(owner).setUpgradeTimelock(await timelock1.getAddress());

      // Owner can no longer rotate directly
      await expect(
        orionConfig.connect(owner).setUpgradeTimelock(await timelock2.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "NotAuthorized");

      // Rotation must go through the active timelock
      const rotateData = orionConfig.interface.encodeFunctionData("setUpgradeTimelock", [await timelock2.getAddress()]);

      await timelock1.schedule(await orionConfig.getAddress(), 0, rotateData, ZERO_BYTES32, SALT, MIN_DELAY);

      await ethers.provider.send("evm_increaseTime", [MIN_DELAY + 1]);
      await ethers.provider.send("evm_mine", []);

      await timelock1.execute(await orionConfig.getAddress(), 0, rotateData, ZERO_BYTES32, SALT);

      expect(await orionConfig.upgradeTimelock()).to.equal(await timelock2.getAddress());
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // upgradeProxy helper path — hardhat-upgrades integration sanity
  // ─────────────────────────────────────────────────────────────────────────────

  describe("upgrades.upgradeProxy – still works before timelock is set", function () {
    it("Should upgrade OrionConfig via hardhat-upgrades before timelock is configured", async function () {
      const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
      await expect(upgrades.upgradeProxy(await orionConfig.getAddress(), OrionConfigFactory)).to.not.be.rejected;
      expect(await orionConfig.owner()).to.equal(owner.address);
    });

    it("Should upgrade PriceAdapterRegistry via hardhat-upgrades before timelock is configured", async function () {
      const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
      await expect(upgrades.upgradeProxy(await priceAdapterRegistry.getAddress(), PriceAdapterRegistryFactory)).to.not
        .be.rejected;
    });

    it("Should upgrade LiquidityOrchestrator via hardhat-upgrades before timelock is configured", async function () {
      const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
      await expect(upgrades.upgradeProxy(await liquidityOrchestrator.getAddress(), LiquidityOrchestratorFactory)).to.not
        .be.rejected;
    });

    it("Should upgrade TransparentVaultFactory via hardhat-upgrades before timelock is configured", async function () {
      const TransparentVaultFactoryFactory = await ethers.getContractFactory("TransparentVaultFactory");
      await expect(upgrades.upgradeProxy(await transparentVaultFactory.getAddress(), TransparentVaultFactoryFactory)).to
        .not.be.rejected;
    });
  });
});
