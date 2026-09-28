/**
 * OrionConfig owner-configurable max Orion vaults cap.
 */
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hh";

import type {
  MockERC4626Asset,
  MockExecutionAdapter,
  MockPriceAdapter,
  MockUnderlyingAsset,
  OrionConfig,
  TransparentVaultFactory,
} from "../typechain-types";
import { deployUpgradeableProtocol, deployUUPSProxy } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";

function vaultAddress(i: number): string {
  return ethers.getAddress(ethers.toBeHex(i + 1, 20));
}

describe("Max Orion vaults cap", function () {
  let orionConfig: OrionConfig;
  let transparentVaultFactory: TransparentVaultFactory;
  let underlyingAsset: MockUnderlyingAsset;
  let owner: SignerWithAddress;
  let strategist: SignerWithAddress;
  let other: SignerWithAddress;
  let factorySigner: SignerWithAddress;

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    [owner, strategist, other] = await ethers.getSigners();
    const deployed = await deployUpgradeableProtocol(owner);
    orionConfig = deployed.orionConfig;
    transparentVaultFactory = deployed.transparentVaultFactory;
    underlyingAsset = deployed.underlyingAsset;

    const factoryAddress = await transparentVaultFactory.getAddress();
    await networkHelpers.impersonateAccount(factoryAddress);
    await networkHelpers.setBalance(factoryAddress, ethers.parseEther("1"));
    factorySigner = await ethers.getSigner(factoryAddress);
  });

  async function totalVaults(): Promise<bigint> {
    return await orionConfig.orionVaultsLength();
  }

  async function addSyntheticVaults(count: number, startIndex = 0): Promise<void> {
    for (let i = 0; i < count; ++i) {
      await orionConfig.connect(factorySigner).addOrionVault(vaultAddress(startIndex + i), 0);
    }
  }

  async function deployAndWhitelistAsset(label: string): Promise<MockERC4626Asset> {
    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    const asset = (await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      `Asset ${label}`,
      label.slice(0, 4),
    )) as unknown as MockERC4626Asset;
    await asset.waitForDeployment();

    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    const priceAdapter = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
    await priceAdapter.waitForDeployment();

    const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
    const executionAdapter = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
    await executionAdapter.waitForDeployment();

    await orionConfig.addWhitelistedAsset(
      await asset.getAddress(),
      await priceAdapter.getAddress(),
      await executionAdapter.getAddress(),
    );
    return asset;
  }

  it("leaves maxOrionVaults at 0 until owner sets a cap; vault add reverts", async function () {
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlying = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset;
    await underlying.waitForDeployment();

    const bareConfig = await deployUUPSProxy<OrionConfig>(
      "OrionConfig",
      [owner.address, await underlying.getAddress()],
      owner,
    );
    expect(await bareConfig.maxOrionVaults()).to.equal(0n);

    const idleLo = await (await ethers.getContractFactory("MockIdleLiquidityOrchestrator")).deploy();
    await idleLo.waitForDeployment();
    await bareConfig.setLiquidityOrchestrator(await idleLo.getAddress());

    const VaultImplFactory = await ethers.getContractFactory("OrionTransparentVault");
    const vaultImpl = await VaultImplFactory.deploy();
    await vaultImpl.waitForDeployment();
    const BeaconFactory = await ethers.getContractFactory("OrionUpgradeableBeacon");
    const beacon = await BeaconFactory.deploy(await vaultImpl.getAddress(), owner.address);
    await beacon.waitForDeployment();
    const factory = await deployUUPSProxy<TransparentVaultFactory>(
      "TransparentVaultFactory",
      [await bareConfig.getAddress(), await beacon.getAddress()],
      owner,
    );
    await bareConfig.setVaultFactory(await factory.getAddress());

    const factoryAddress = await factory.getAddress();
    await networkHelpers.impersonateAccount(factoryAddress);
    await networkHelpers.setBalance(factoryAddress, ethers.parseEther("1"));
    const bareFactorySigner = await ethers.getSigner(factoryAddress);

    await expect(bareConfig.connect(bareFactorySigner).addOrionVault(vaultAddress(0), 0))
      .to.be.revertedWithCustomError(bareConfig, "MaxOrionVaultsExceeded")
      .withArgs(1n, 0n);
  });

  it("allows vaults up to the cap then rejects the next", async function () {
    const cap = 5n;
    await orionConfig.setMaxOrionVaults(cap);

    await addSyntheticVaults(Number(cap));
    expect(await totalVaults()).to.equal(cap);

    await expect(orionConfig.connect(factorySigner).addOrionVault(vaultAddress(Number(cap)), 0))
      .to.be.revertedWithCustomError(orionConfig, "MaxOrionVaultsExceeded")
      .withArgs(cap + 1n, cap);

    expect(await totalVaults()).to.equal(cap);
  });

  it("setMaxOrionVaults is onlyOwner and rejects 0 or below current vault count", async function () {
    await expect(orionConfig.connect(other).setMaxOrionVaults(10n)).to.be.revertedWithCustomError(
      orionConfig,
      "OwnableUnauthorizedAccount",
    );

    await expect(orionConfig.setMaxOrionVaults(0n)).to.be.revertedWithCustomError(orionConfig, "InvalidArguments");

    await orionConfig.setMaxOrionVaults(10n);
    await addSyntheticVaults(3);
    await expect(orionConfig.setMaxOrionVaults(2n)).to.be.revertedWithCustomError(orionConfig, "InvalidArguments");

    await expect(orionConfig.setMaxOrionVaults(3n)).to.emit(orionConfig, "MaxOrionVaultsUpdated").withArgs(3n);
    expect(await orionConfig.maxOrionVaults()).to.equal(3n);

    await expect(orionConfig.connect(factorySigner).addOrionVault(vaultAddress(3), 0))
      .to.be.revertedWithCustomError(orionConfig, "MaxOrionVaultsExceeded")
      .withArgs(4n, 3n);
  });

  it("createVault path hits the same vault cap", async function () {
    await orionConfig.setMaxOrionVaults(2n);
    await addSyntheticVaults(2);

    await expect(
      transparentVaultFactory
        .connect(owner)
        .createVault(
          strategist.address,
          "Over Cap",
          "OC",
          0,
          0,
          0,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
        ),
    ).to.be.revertedWithCustomError(orionConfig, "MaxOrionVaultsExceeded");

    expect(await totalVaults()).to.equal(2n);
  });

  it("addWhitelistedAsset is not gated by vault count", async function () {
    await orionConfig.setMaxOrionVaults(3n);
    await addSyntheticVaults(3);

    // Still at vault cap — assets can still be added (admin-trusted).
    await deployAndWhitelistAsset("A2");
    await deployAndWhitelistAsset("A3");
    expect(await orionConfig.whitelistedAssetsLength()).to.equal(3n);
    expect(await totalVaults()).to.equal(3n);
  });
});
