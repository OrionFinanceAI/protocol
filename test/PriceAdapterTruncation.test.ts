import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import "@openzeppelin/hardhat-upgrades";
import { MockUnderlyingAsset, MockERC4626Asset, OrionAssetERC4626PriceAdapter, OrionConfig } from "../typechain-types";

describe("Price Adapter Truncation", function () {
  let underlying: MockUnderlyingAsset;
  let vault: MockERC4626Asset;
  let priceAdapter: OrionAssetERC4626PriceAdapter;
  let orionConfig: OrionConfig;
  let deployer: SignerWithAddress;
  beforeEach(async function () {
    [deployer] = await ethers.getSigners();

    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    underlying = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset;
    await underlying.waitForDeployment();

    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    orionConfig = (await upgrades.deployProxy(OrionConfigFactory, [deployer.address, await underlying.getAddress()], {
      initializer: "initialize",
      kind: "uups",
    })) as unknown as OrionConfig;
    await orionConfig.waitForDeployment();

    const OrionAssetERC4626PriceAdapterFactory = await ethers.getContractFactory("OrionAssetERC4626PriceAdapter");
    priceAdapter = (await OrionAssetERC4626PriceAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as OrionAssetERC4626PriceAdapter;
    await priceAdapter.waitForDeployment();

    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    vault = (await MockERC4626AssetFactory.deploy(
      await underlying.getAddress(),
      "Test Vault",
      "TV",
    )) as unknown as MockERC4626Asset;
    await vault.waitForDeployment();

    const hugeDeposit = ethers.parseUnits("1000000000000000000000000", 6);

    await underlying.mint(deployer.address, hugeDeposit);
    await underlying.connect(deployer).approve(await vault.getAddress(), hugeDeposit);
    await vault.connect(deployer).deposit(hugeDeposit, deployer.address);

    const totalSupply = await vault.totalSupply();
    const targetRatio = 1234567890123n;
    const targetTotalAssets = (totalSupply * targetRatio) / 1000000000000n;
    const currentTotalAssets = await vault.totalAssets();
    const extraAmount = targetTotalAssets > currentTotalAssets ? targetTotalAssets - currentTotalAssets : 0n;

    if (extraAmount > 0n) {
      await underlying.mint(deployer.address, extraAmount);
      await underlying.transfer(await vault.getAddress(), extraAmount);
    }
  });

  it("should demonstrate ERC4626 getPriceData preserves precision and avoids truncation", async function () {
    const totalSupply = await vault.totalSupply();
    const totalAssets = await vault.totalAssets();

    const trueExchangeRateNumber = Number(totalAssets) / Number(totalSupply);

    const [priceFromAdapter, priceDecimals] = await priceAdapter.getPriceData(await vault.getAddress());

    const measuredExchangeRateNumber = Number(priceFromAdapter) / 10 ** Number(priceDecimals);

    const difference =
      measuredExchangeRateNumber > trueExchangeRateNumber
        ? measuredExchangeRateNumber - trueExchangeRateNumber
        : trueExchangeRateNumber - measuredExchangeRateNumber;

    expect(difference).to.be.lt(1e-12);
  });
});
