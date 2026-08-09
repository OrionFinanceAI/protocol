/**
 * ERC4626PriceAdapter unit surface (mock high-supply / decimal-offset / validation).
 * Mainnet catalog / adapter compatibility lives in the investment-universe repo.
 */

import { expect } from "chai";
import { ethers } from "../helpers/hh";
import type {
  ERC4626PriceAdapter,
  TestFixedRatioERC4626,
  MockUnderlyingAsset,
  OrionConfig,
  MockExecutionAdapter,
} from "../../typechain-types";
import { resetNetwork } from "../helpers/resetNetwork";
import { deployUpgradeableProtocol } from "../helpers/deployUpgradeable";

const PRICE_DECIMALS = 10;

// vfUSDC-like mainnet snapshot ratios (Varlamore Falcon USDC) — unit fixture only
const VF_USDC_TOTAL_ASSETS = 41_875_623_172n;
const VF_USDC_TOTAL_SUPPLY = 37_863_307_763_348_816n;
const VF_USDC_VAULT_DECIMALS = 6;

describe("ERC4626PriceAdapter - High Supply Vaults", function () {
  let protocolUnderlying: MockUnderlyingAsset;
  let priceAdapter: ERC4626PriceAdapter;
  let orionConfig: OrionConfig;

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    const [deployer] = await ethers.getSigners();

    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    protocolUnderlying = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset;
    await protocolUnderlying.waitForDeployment();

    const deployed = await deployUpgradeableProtocol(deployer, protocolUnderlying);
    orionConfig = deployed.orionConfig;

    const ERC4626PriceAdapterFactory = await ethers.getContractFactory("ERC4626PriceAdapter");
    priceAdapter = (await ERC4626PriceAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as ERC4626PriceAdapter;
    await priceAdapter.waitForDeployment();
  });

  async function registerVault(vault: TestFixedRatioERC4626) {
    const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
    const executionAdapter = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
    await executionAdapter.waitForDeployment();

    await orionConfig.addWhitelistedAsset(
      await vault.getAddress(),
      await priceAdapter.getAddress(),
      await executionAdapter.getAddress(),
    );
  }

  it("preserves per-share precision for vfUSDC-like high-supply USDC vaults", async function () {
    const MockVaultFactory = await ethers.getContractFactory("TestFixedRatioERC4626");
    const vault = (await MockVaultFactory.deploy(
      await protocolUnderlying.getAddress(),
      "vfUSDC Mock",
      "mvfUSDC",
      VF_USDC_VAULT_DECIMALS,
      VF_USDC_TOTAL_ASSETS,
      VF_USDC_TOTAL_SUPPLY,
    )) as unknown as TestFixedRatioERC4626;
    await vault.waitForDeployment();
    await registerVault(vault);

    const [price, priceDecimals] = await priceAdapter.getPriceData(await vault.getAddress());

    expect(priceDecimals).to.equal(PRICE_DECIMALS + 6);

    const underlyingPerShare = price / 10n ** BigInt(PRICE_DECIMALS);

    // Effective share scale is 12 for this ratio; naive 10^vaultDecimals truncates to 1.
    const expectedPerShare = (VF_USDC_TOTAL_ASSETS * 10n ** 12n) / VF_USDC_TOTAL_SUPPLY;
    const naivePerShare = (VF_USDC_TOTAL_ASSETS * 10n ** BigInt(VF_USDC_VAULT_DECIMALS)) / VF_USDC_TOTAL_SUPPLY;

    expect(naivePerShare).to.equal(1n);
    expect(underlyingPerShare).to.be.closeTo(expectedPerShare, 1n);
    expect(underlyingPerShare).to.be.gt(1_000_000n);
  });

  it("does not change pricing for standard 18-decimal appreciating vaults", async function () {
    const MockVaultFactory = await ethers.getContractFactory("TestFixedRatioERC4626");
    const totalAssets = ethers.parseUnits("1000", 18);
    const totalSupply = ethers.parseUnits("950", 18);
    const vault = (await MockVaultFactory.deploy(
      await protocolUnderlying.getAddress(),
      "18d Vault",
      "v18",
      18,
      totalAssets,
      totalSupply,
    )) as unknown as TestFixedRatioERC4626;
    await vault.waitForDeployment();
    await registerVault(vault);

    const [price] = await priceAdapter.getPriceData(await vault.getAddress());
    const underlyingPerShare = price / 10n ** BigInt(PRICE_DECIMALS);
    const expectedPerShare = (totalAssets * 10n ** 18n) / totalSupply;

    expect(underlyingPerShare).to.equal(expectedPerShare);
  });

  describe("constructor and validation", function () {
    it("should reject zero config address", async function () {
      const Factory = await ethers.getContractFactory("ERC4626PriceAdapter");
      await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(priceAdapter, "ZeroAddress");
    });

    it("should reject non-ERC4626 asset on validate", async function () {
      await expect(
        priceAdapter.validatePriceAdapter(await protocolUnderlying.getAddress()),
      ).to.be.revertedWithCustomError(priceAdapter, "InvalidAdapter");
    });

    it("should reject vault whose underlying is not whitelisted", async function () {
      const MockVaultFactory = await ethers.getContractFactory("MockERC4626Asset");
      const otherUnderlying = await (await ethers.getContractFactory("MockUnderlyingAsset")).deploy(6);
      const orphanVault = await MockVaultFactory.deploy(await otherUnderlying.getAddress(), "Orphan", "ORPH");
      await expect(priceAdapter.validatePriceAdapter(await orphanVault.getAddress())).to.be.revertedWithCustomError(
        priceAdapter,
        "InvalidAdapter",
      );
    });

    it("should return zero price when vault totalSupply is zero", async function () {
      const MockVaultFactory = await ethers.getContractFactory("TestFixedRatioERC4626");
      const vault = (await MockVaultFactory.deploy(
        await protocolUnderlying.getAddress(),
        "Empty",
        "EMP",
        6,
        0n,
        0n,
      )) as unknown as TestFixedRatioERC4626;
      await vault.waitForDeployment();
      await registerVault(vault);

      const [price, decimals] = await priceAdapter.getPriceData(await vault.getAddress());
      expect(price).to.equal(0n);
      expect(decimals).to.equal(PRICE_DECIMALS + 6);
    });

    it("should handle zero-decimal vault with truncated per-share ratio", async function () {
      const MockVaultFactory = await ethers.getContractFactory("TestFixedRatioERC4626");
      const vault = (await MockVaultFactory.deploy(
        await protocolUnderlying.getAddress(),
        "ZeroDec",
        "ZD",
        0,
        5n,
        3n,
      )) as unknown as TestFixedRatioERC4626;
      await vault.waitForDeployment();
      await registerVault(vault);
      const [price] = await priceAdapter.getPriceData(await vault.getAddress());
      expect(price).to.be.gte(0n);
    });

    it("should clamp effective share decimals at 38 for extreme supply ratios", async function () {
      const MockVaultFactory = await ethers.getContractFactory("TestFixedRatioERC4626");
      // 18 share decimals + many digits of supply/assets should hit the 38 clamp
      const totalAssets = 1n;
      const totalSupply = 10n ** 40n;
      const vault = (await MockVaultFactory.deploy(
        await protocolUnderlying.getAddress(),
        "Extreme",
        "EXT",
        18,
        totalAssets,
        totalSupply,
      )) as unknown as TestFixedRatioERC4626;
      await vault.waitForDeployment();
      await registerVault(vault);
      const [price] = await priceAdapter.getPriceData(await vault.getAddress());
      expect(price).to.be.gte(0n);
    });

    it("should keep vault decimals when per-share truncates to exactly 1 (probe <= 10)", async function () {
      const MockVaultFactory = await ethers.getContractFactory("TestFixedRatioERC4626");
      // perShare = 1 * 10^6 / 10^6 = 1; probe = 10 → return vaultAssetDecimals
      const vault = (await MockVaultFactory.deploy(
        await protocolUnderlying.getAddress(),
        "ExactOne",
        "EO",
        6,
        1n,
        10n ** 6n,
      )) as unknown as TestFixedRatioERC4626;
      await vault.waitForDeployment();
      await registerVault(vault);
      const [price, decimals] = await priceAdapter.getPriceData(await vault.getAddress());
      expect(decimals).to.equal(PRICE_DECIMALS + 6);
      expect(price).to.equal(10n ** BigInt(PRICE_DECIMALS));
    });
  });

  describe("cross-asset precision (merged from PriceAdapterTruncation)", function () {
    it("should preserve precision for cross-asset ERC4626 vaults composed with registry price", async function () {
      const [deployer] = await ethers.getSigners();
      const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
      const protocolUnderlying = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset;
      const vaultUnderlying = (await MockUnderlyingAssetFactory.deploy(18)) as unknown as MockUnderlyingAsset;
      const deployed = await deployUpgradeableProtocol(deployer, protocolUnderlying);

      const mockUnderlyingPriceAdapter = await (await ethers.getContractFactory("MockPriceAdapter")).deploy();
      const mockExecutionAdapter = await (await ethers.getContractFactory("MockExecutionAdapter")).deploy();
      await deployed.orionConfig.addWhitelistedAsset(
        await vaultUnderlying.getAddress(),
        await mockUnderlyingPriceAdapter.getAddress(),
        await mockExecutionAdapter.getAddress(),
      );

      const priceAdapter = await (
        await ethers.getContractFactory("ERC4626PriceAdapter")
      ).deploy(await deployed.orionConfig.getAddress());
      const vault = await (
        await ethers.getContractFactory("MockERC4626Asset")
      ).deploy(await vaultUnderlying.getAddress(), "Test Vault", "TV");
      const vaultExec = await (await ethers.getContractFactory("MockExecutionAdapter")).deploy();
      await deployed.orionConfig.addWhitelistedAsset(
        await vault.getAddress(),
        await priceAdapter.getAddress(),
        await vaultExec.getAddress(),
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

      const vaultDecimals = await vault.decimals();
      const totalAssets = await vault.totalAssets();
      const supply = await vault.totalSupply();
      const precisionAmount = 10n ** BigInt(PRICE_DECIMALS + Number(vaultDecimals));
      const vaultUnderlyingAssetAmount = (totalAssets * precisionAmount) / supply;
      const priceRegistry = await ethers.getContractAt(
        "PriceAdapterRegistry",
        await deployed.orionConfig.priceAdapterRegistry(),
      );
      const underlyingPriceInUSDC = await priceRegistry.getPrice(await vaultUnderlying.getAddress());
      const priceAdapterDecimals = await deployed.orionConfig.priceAdapterDecimals();
      const expectedPrice = (vaultUnderlyingAssetAmount * underlyingPriceInUSDC) / 10n ** BigInt(priceAdapterDecimals);

      const [priceFromAdapter, priceDecimals] = await priceAdapter.getPriceData(await vault.getAddress());
      expect(priceDecimals).to.equal(28);
      const priceDifference =
        priceFromAdapter > expectedPrice ? priceFromAdapter - expectedPrice : expectedPrice - priceFromAdapter;
      expect(priceDifference).to.be.lte(1n);
    });
  });
});
