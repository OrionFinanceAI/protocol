import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hh";
import { deployUUPSProxy } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";
import type { MockUnderlyingAsset, OrionConfig, PriceAdapterRegistry } from "../typechain-types";

describe("OrionConfig bootstrap and guardian ACL", function () {
  before(async function () {
    await resetNetwork();
  });

  async function deployFreshConfig() {
    const [owner, guardian, stranger] = await ethers.getSigners();

    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAsset = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset;
    await underlyingAsset.waitForDeployment();

    const orionConfig = await deployUUPSProxy<OrionConfig>(
      "OrionConfig",
      [owner.address, await underlyingAsset.getAddress()],
      owner,
    );

    return { owner, guardian, stranger, orionConfig, underlyingAsset };
  }

  async function deployConfigWithLo() {
    const fixture = await deployFreshConfig();
    const { orionConfig, owner } = fixture;

    const priceAdapterRegistry = await deployUUPSProxy<PriceAdapterRegistry>(
      "PriceAdapterRegistry",
      [owner.address, await orionConfig.getAddress()],
      owner,
    );
    await orionConfig.connect(owner).setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

    const SP1VerifierGatewayFactory = await ethers.getContractFactory("SP1VerifierGateway");
    const gateway = await SP1VerifierGatewayFactory.deploy(owner.address);
    await gateway.waitForDeployment();
    const SP1VerifierFactory = await ethers.getContractFactory("SP1Verifier");
    const verifier = await SP1VerifierFactory.deploy();
    await verifier.waitForDeployment();
    await gateway.addRoute(await verifier.getAddress());
    const vKey = "0x007ccff4696ddd1d62fec2a106aa50309ba0fdee8fc2bcbc9c0b5ea68fe200f3";
    const lo = await deployUUPSProxy(
      "LiquidityOrchestrator",
      [owner.address, await orionConfig.getAddress(), owner.address, await gateway.getAddress(), vKey],
      owner,
    );
    await orionConfig.connect(owner).setLiquidityOrchestrator(await lo.getAddress());

    return { ...fixture, lo, priceAdapterRegistry };
  }

  describe("one-shot setters", function () {
    it("Should reject zero address and non-owner for bootstrap setters", async function () {
      const { orionConfig, owner, stranger } = await networkHelpers.loadFixture(deployFreshConfig);

      // These setters do not require LO / isSystemIdle
      await expect(
        orionConfig.connect(owner).setLiquidityOrchestrator(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(orionConfig, "ZeroAddress");
      await expect(
        orionConfig.connect(owner).setPriceAdapterRegistry(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(orionConfig, "ZeroAddress");

      await expect(
        orionConfig.connect(stranger).setLiquidityOrchestrator(stranger.address),
      ).to.be.revertedWithCustomError(orionConfig, "OwnableUnauthorizedAccount");
      await expect(
        orionConfig.connect(stranger).setPriceAdapterRegistry(stranger.address),
      ).to.be.revertedWithCustomError(orionConfig, "OwnableUnauthorizedAccount");
      await expect(orionConfig.connect(stranger).setVaultFactory(stranger.address)).to.be.revertedWithCustomError(
        orionConfig,
        "OwnableUnauthorizedAccount",
      );
    });

    it("Should reject zero vault factory after LO is wired (isSystemIdle path)", async function () {
      const { orionConfig, owner } = await networkHelpers.loadFixture(deployConfigWithLo);

      await expect(orionConfig.connect(owner).setVaultFactory(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        orionConfig,
        "ZeroAddress",
      );
    });

    it("Should revert AlreadyRegistered on second set of LO, registry, and factory", async function () {
      const { orionConfig, owner, lo, priceAdapterRegistry } = await networkHelpers.loadFixture(deployConfigWithLo);

      await expect(
        orionConfig.connect(owner).setPriceAdapterRegistry(await priceAdapterRegistry.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "AlreadyRegistered");
      await expect(
        orionConfig.connect(owner).setLiquidityOrchestrator(await lo.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "AlreadyRegistered");

      const VaultImplFactory = await ethers.getContractFactory("OrionTransparentVault");
      const vaultImpl = await VaultImplFactory.deploy();
      await vaultImpl.waitForDeployment();
      const BeaconFactory = await ethers.getContractFactory("OrionUpgradeableBeacon");
      const vaultBeacon = await BeaconFactory.deploy(await vaultImpl.getAddress(), owner.address);
      await vaultBeacon.waitForDeployment();
      const factory = await deployUUPSProxy(
        "TransparentVaultFactory",
        [owner.address, await orionConfig.getAddress(), await vaultBeacon.getAddress()],
        owner,
      );
      await orionConfig.connect(owner).setVaultFactory(await factory.getAddress());
      await expect(
        orionConfig.connect(owner).setVaultFactory(await factory.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "AlreadyRegistered");
    });
  });

  describe("guardian ACL on operational knobs", function () {
    it("Should allow guardian and owner, reject stranger and zero values", async function () {
      const { orionConfig, owner, guardian, stranger } = await networkHelpers.loadFixture(deployConfigWithLo);
      await orionConfig.connect(owner).setGuardian(guardian.address);

      await expect(orionConfig.connect(stranger).setMinDepositAmount(1)).to.be.revertedWithCustomError(
        orionConfig,
        "NotAuthorized",
      );
      await expect(orionConfig.connect(stranger).setMaxFulfillBatchSize(1)).to.be.revertedWithCustomError(
        orionConfig,
        "NotAuthorized",
      );

      await expect(orionConfig.connect(guardian).setMinDepositAmount(0)).to.be.revertedWithCustomError(
        orionConfig,
        "InvalidArguments",
      );
      await expect(orionConfig.connect(guardian).setMaxFulfillBatchSize(0)).to.be.revertedWithCustomError(
        orionConfig,
        "InvalidArguments",
      );

      await orionConfig.connect(guardian).setMinDepositAmount(100n);
      expect(await orionConfig.minDepositAmount()).to.equal(100n);

      await orionConfig.connect(owner).setMaxFulfillBatchSize(50n);
      expect(await orionConfig.maxFulfillBatchSize()).to.equal(50n);
    });
  });
});
