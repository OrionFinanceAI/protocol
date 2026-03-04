import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import "@openzeppelin/hardhat-upgrades";
import {
  MockUnderlyingAsset,
  MockERC4626Asset,
  ERC4626PriceAdapter,
  OrionConfig,
  MockExecutionAdapter,
  MockPriceAdapter,
} from "../typechain-types";
import { resetNetwork } from "./helpers/resetNetwork";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";

describe("Price Adapter Truncation", function () {
  let protocolUnderlying: MockUnderlyingAsset;
  let vaultUnderlying: MockUnderlyingAsset;
  let vault: MockERC4626Asset;
  let priceAdapter: ERC4626PriceAdapter;
  let orionConfig: OrionConfig;
  let deployer: SignerWithAddress;

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    [deployer] = await ethers.getSigners();

    // Deploy USDC as protocol underlying (6 decimals)
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    protocolUnderlying = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset;
    await protocolUnderlying.waitForDeployment();

    // Deploy protocol infrastructure
    const deployed = await deployUpgradeableProtocol(deployer, protocolUnderlying);
    orionConfig = deployed.orionConfig;

    // Deploy WETH-like token as vault underlying (18 decimals, different from protocol underlying)
    vaultUnderlying = (await MockUnderlyingAssetFactory.deploy(18)) as unknown as MockUnderlyingAsset;
    await vaultUnderlying.waitForDeployment();

    // Deploy MockPriceAdapter for WETH that returns 1:1 with USDC for precision testing
    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    const mockUnderlyingPriceAdapter = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
    await mockUnderlyingPriceAdapter.waitForDeployment();

    // Register WETH with price adapter
    const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
    const mockExecutionAdapter = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
    await mockExecutionAdapter.waitForDeployment();
    await orionConfig.addWhitelistedAsset(
      await vaultUnderlying.getAddress(),
      await mockUnderlyingPriceAdapter.getAddress(),
      await mockExecutionAdapter.getAddress(),
    );

    // Deploy ERC4626PriceAdapter for testing precision
    const ERC4626PriceAdapterFactory = await ethers.getContractFactory("ERC4626PriceAdapter");
    priceAdapter = (await ERC4626PriceAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as ERC4626PriceAdapter;
    await priceAdapter.waitForDeployment();

    // Deploy vault with WETH as underlying (cross-asset vault)
    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    vault = (await MockERC4626AssetFactory.deploy(
      await vaultUnderlying.getAddress(),
      "Test Vault",
      "TV",
    )) as unknown as MockERC4626Asset;
    await vault.waitForDeployment();

    // Register vault with OrionConfig
    const vaultMockExecutionAdapter = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
    await vaultMockExecutionAdapter.waitForDeployment();
    await orionConfig.addWhitelistedAsset(
      await vault.getAddress(),
      await priceAdapter.getAddress(),
      await vaultMockExecutionAdapter.getAddress(),
    );

    const hugeDeposit = ethers.parseUnits("1000000000000000000000000", 18);

    await vaultUnderlying.mint(deployer.address, hugeDeposit);
    await vaultUnderlying.connect(deployer).approve(await vault.getAddress(), hugeDeposit);
    await vault.connect(deployer).deposit(hugeDeposit, deployer.address);

    const totalSupply = await vault.totalSupply();
    const targetRatio = 1234567890123n;
    const targetTotalAssets = (totalSupply * targetRatio) / 1000000000000n;
    const currentTotalAssets = await vault.totalAssets();
    const extraAmount = targetTotalAssets > currentTotalAssets ? targetTotalAssets - currentTotalAssets : 0n;

    if (extraAmount > 0n) {
      await vaultUnderlying.mint(deployer.address, extraAmount);
      await vaultUnderlying.transfer(await vault.getAddress(), extraAmount);
    }
  });

  it("should demonstrate ERC4626 getPriceData preserves precision and avoids truncation", async function () {
    // ERC4626PriceAdapter uses: precisionAmount = 10^(PRICE_DECIMALS + vaultDecimals), then
    // vaultPrice = convertToAssets(precisionAmount).mulDiv(underlyingPrice, 10^priceAdapterDecimals)
    // Replicate that formula for expected price.

    const vaultDecimals = await vault.decimals();
    const precisionAmount = 10n ** BigInt(10 + Number(vaultDecimals)); // PRICE_DECIMALS (10) + vault decimals (18) = 10^28
    const vaultUnderlyingAssetAmount = await vault.convertToAssets(precisionAmount);

    const priceRegistry = await ethers.getContractAt("PriceAdapterRegistry", await orionConfig.priceAdapterRegistry());
    const underlyingPriceInUSDC = await priceRegistry.getPrice(await vaultUnderlying.getAddress());
    const priceAdapterDecimals = await orionConfig.priceAdapterDecimals();

    const expectedPrice = (vaultUnderlyingAssetAmount * underlyingPriceInUSDC) / 10n ** BigInt(priceAdapterDecimals);

    const [priceFromAdapter, priceDecimals] = await priceAdapter.getPriceData(await vault.getAddress());

    expect(priceDecimals).to.equal(28);

    const priceDifference =
      priceFromAdapter > expectedPrice ? priceFromAdapter - expectedPrice : expectedPrice - priceFromAdapter;

    expect(priceDifference).to.be.lte(1n, "ERC4626PriceAdapter should preserve precision within 1 unit");
  });
});
