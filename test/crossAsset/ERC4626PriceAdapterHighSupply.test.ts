/**
 * ERC4626PriceAdapter unit surface (mock high-supply / decimal-offset / validation).
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
const PRICE_ADAPTER_DECIMALS = 14;
const USDC_DECIMALS = 6;
/** Reported getPriceData decimals: PRICE_DECIMALS + protocol underlying decimals. */
const REPORTED_DECIMALS = PRICE_DECIMALS + USDC_DECIMALS;

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

  async function getRegistryPrice(vaultAddress: string): Promise<bigint> {
    const priceRegistry = await ethers.getContractAt("PriceAdapterRegistry", await orionConfig.priceAdapterRegistry());
    return priceRegistry.getPrice(vaultAddress);
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

    const [, priceDecimals] = await priceAdapter.getPriceData(await vault.getAddress());
    expect(priceDecimals).to.equal(REPORTED_DECIMALS);

    const naivePerShare = (VF_USDC_TOTAL_ASSETS * 10n ** BigInt(VF_USDC_VAULT_DECIMALS)) / VF_USDC_TOTAL_SUPPLY;
    expect(naivePerShare).to.equal(1n);

    // Effective share scale preserves ratio; after whole-share scale-down registry matches assets/supply.
    const expectedRegistryPrice = (VF_USDC_TOTAL_ASSETS * 10n ** BigInt(PRICE_ADAPTER_DECIMALS)) / VF_USDC_TOTAL_SUPPLY;
    const registryPrice = await getRegistryPrice(await vault.getAddress());
    expect(registryPrice).to.be.closeTo(expectedRegistryPrice, 1n);
  });

  it("normalizes 18-decimal USDC vaults to USDC-per-whole-share at registry decimals", async function () {
    const MockVaultFactory = await ethers.getContractFactory("TestFixedRatioERC4626");
    // ~1.14 USDC per whole share (Steakhouse-style): assets in USDC-6, shares in 18 decimals.
    const totalSupply = 10n ** 18n;
    const assetsPerWholeShare = 1_141_790n; // USDC-6
    const totalAssets = assetsPerWholeShare; // supply is exactly 1 whole share
    const vault = (await MockVaultFactory.deploy(
      await protocolUnderlying.getAddress(),
      "18d USDC Vault",
      "v18",
      18,
      totalAssets,
      totalSupply,
    )) as unknown as TestFixedRatioERC4626;
    await vault.waitForDeployment();
    await registerVault(vault);

    const [price, priceDecimals] = await priceAdapter.getPriceData(await vault.getAddress());
    expect(priceDecimals).to.equal(REPORTED_DECIMALS);

    const underlyingPerShare = price / 10n ** BigInt(PRICE_DECIMALS);
    expect(underlyingPerShare).to.equal(assetsPerWholeShare);

    // Registry: USDC-per-whole-share at 14 decimals ≈ 1.14179e14
    const expectedRegistryPrice = assetsPerWholeShare * 10n ** BigInt(PRICE_ADAPTER_DECIMALS - USDC_DECIMALS);
    const registryPrice = await getRegistryPrice(await vault.getAddress());
    expect(registryPrice).to.be.closeTo(expectedRegistryPrice, 1n);

    // Fork mental model: fromPrice (USDC-6) ≈ convertToAssets(1e18)
    const fromPrice = registryPrice / 10n ** BigInt(PRICE_ADAPTER_DECIMALS - USDC_DECIMALS);
    expect(fromPrice).to.be.closeTo(assetsPerWholeShare, 3n);
  });

  it("prices honest offset-style vaults (decimals=12) at USDC-per-whole-share", async function () {
    const MockVaultFactory = await ethers.getContractFactory("TestFixedRatioERC4626");
    // Same vfUSDC ratio, but share decimals already include the offset — no bump path.
    const vaultDecimals = 12;
    const vault = (await MockVaultFactory.deploy(
      await protocolUnderlying.getAddress(),
      "vfUSDC Offset",
      "vfOffset",
      vaultDecimals,
      VF_USDC_TOTAL_ASSETS,
      VF_USDC_TOTAL_SUPPLY,
    )) as unknown as TestFixedRatioERC4626;
    await vault.waitForDeployment();
    await registerVault(vault);

    const [, priceDecimals] = await priceAdapter.getPriceData(await vault.getAddress());
    expect(priceDecimals).to.equal(REPORTED_DECIMALS);

    // Whole share = 10^vaultDecimals; registry = convertToAssets(10^d) * 10^(14-6)
    const expectedRegistryPrice =
      (VF_USDC_TOTAL_ASSETS * 10n ** BigInt(PRICE_ADAPTER_DECIMALS - USDC_DECIMALS + vaultDecimals)) /
      VF_USDC_TOTAL_SUPPLY;
    const registryPrice = await getRegistryPrice(await vault.getAddress());
    expect(registryPrice).to.be.closeTo(expectedRegistryPrice, 1n);
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

    it("should return 1:1 unit price when vault totalSupply is zero", async function () {
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
      expect(decimals).to.equal(REPORTED_DECIMALS);
      expect(price).to.equal(10n ** BigInt(REPORTED_DECIMALS));

      const registryPrice = await getRegistryPrice(await vault.getAddress());
      expect(registryPrice).to.equal(10n ** BigInt(PRICE_ADAPTER_DECIMALS));
    });

    it("should return 1:1 for empty 18-decimal vaults", async function () {
      const MockVaultFactory = await ethers.getContractFactory("TestFixedRatioERC4626");
      const vault = (await MockVaultFactory.deploy(
        await protocolUnderlying.getAddress(),
        "Empty18",
        "E18",
        18,
        0n,
        0n,
      )) as unknown as TestFixedRatioERC4626;
      await vault.waitForDeployment();
      await registerVault(vault);

      const [price, decimals] = await priceAdapter.getPriceData(await vault.getAddress());
      expect(decimals).to.equal(REPORTED_DECIMALS);
      expect(price).to.equal(10n ** BigInt(REPORTED_DECIMALS));

      const registryPrice = await getRegistryPrice(await vault.getAddress());
      expect(registryPrice).to.equal(10n ** BigInt(PRICE_ADAPTER_DECIMALS));
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
      const [price, decimals] = await priceAdapter.getPriceData(await vault.getAddress());
      expect(decimals).to.equal(REPORTED_DECIMALS);
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
      const [price, decimals] = await priceAdapter.getPriceData(await vault.getAddress());
      expect(decimals).to.equal(REPORTED_DECIMALS);
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
      expect(decimals).to.equal(REPORTED_DECIMALS);
      expect(price).to.equal(10n ** BigInt(PRICE_DECIMALS));
    });
  });

  describe("cross-asset precision (merged from PriceAdapterTruncation)", function () {
    it("should price empty cross-asset vault at 1.0 without vaultUnderlyingDecimals conversion", async function () {
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

      // Empty vault: 18-dec shares, 18-dec underlying ≠ protocol USDC-6.
      const MockVaultFactory = await ethers.getContractFactory("TestFixedRatioERC4626");
      const vault = (await MockVaultFactory.deploy(
        await vaultUnderlying.getAddress(),
        "EmptyCross",
        "EXC",
        18,
        0n,
        0n,
      )) as unknown as TestFixedRatioERC4626;
      await vault.waitForDeployment();

      const vaultExec = await (await ethers.getContractFactory("MockExecutionAdapter")).deploy();
      await deployed.orionConfig.addWhitelistedAsset(
        await vault.getAddress(),
        await priceAdapter.getAddress(),
        await vaultExec.getAddress(),
      );

      const priceRegistry = await ethers.getContractAt(
        "PriceAdapterRegistry",
        await deployed.orionConfig.priceAdapterRegistry(),
      );
      const underlyingPriceInUSDC = await priceRegistry.getPrice(await vaultUnderlying.getAddress());
      const priceAdapterDecimals = await deployed.orionConfig.priceAdapterDecimals();

      // Empty fallback stays in protocol scale; compose with registry price (no /10^(18-6)).
      const [price, decimals] = await priceAdapter.getPriceData(await vault.getAddress());
      expect(decimals).to.equal(REPORTED_DECIMALS);
      const expectedAdapterPrice =
        (10n ** BigInt(REPORTED_DECIMALS) * underlyingPriceInUSDC) / 10n ** BigInt(priceAdapterDecimals);
      expect(price).to.equal(expectedAdapterPrice);

      const registryPrice = await priceRegistry.getPrice(await vault.getAddress());
      expect(registryPrice).to.equal(underlyingPriceInUSDC);
    });

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
      const vaultUnderlyingDecimals = await vaultUnderlying.decimals();
      const wholeShare = 10n ** BigInt(vaultDecimals);
      const underlyingPerWholeShare = await vault.convertToAssets(wholeShare);

      const priceRegistry = await ethers.getContractAt(
        "PriceAdapterRegistry",
        await deployed.orionConfig.priceAdapterRegistry(),
      );
      const underlyingPriceInUSDC = await priceRegistry.getPrice(await vaultUnderlying.getAddress());
      const priceAdapterDecimals = await deployed.orionConfig.priceAdapterDecimals();

      // USDC per whole vault share at registry precision (independent of adapter math).
      const expectedRegistryPrice =
        (underlyingPerWholeShare * underlyingPriceInUSDC) / 10n ** BigInt(vaultUnderlyingDecimals);
      const registryPrice = await priceRegistry.getPrice(await vault.getAddress());
      expect(registryPrice).to.be.closeTo(expectedRegistryPrice, 2n);

      const [priceFromAdapter, priceDecimals] = await priceAdapter.getPriceData(await vault.getAddress());
      expect(priceDecimals).to.equal(REPORTED_DECIMALS);
      const expectedAdapterPrice =
        (underlyingPerWholeShare * underlyingPriceInUSDC) /
        10n ** BigInt(Number(vaultUnderlyingDecimals) + Number(priceAdapterDecimals) - REPORTED_DECIMALS);
      const priceDifference =
        priceFromAdapter > expectedAdapterPrice
          ? priceFromAdapter - expectedAdapterPrice
          : expectedAdapterPrice - priceFromAdapter;
      expect(priceDifference).to.be.lte(1n);
    });
  });
});
