/**
 * ERC4626PriceAdapter Coverage Tests
 *
 * Comprehensive test suite to end to end test ERC4626PriceAdapter.sol
 * Tests cross-asset vault pricing composition and error handling.
 */

import { expect } from "chai";
import { ethers } from "../helpers/hh";
import type {
  ERC4626PriceAdapter,
  MockOrionConfig,
  ChainlinkPriceAdapter,
  MockPriceAdapterRegistry,
  IERC4626,
} from "../typechain-types";

// Mainnet addresses
const MAINNET = {
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  MORPHO_WETH: "0x31A5684983EeE865d943A696AAC155363bA024f9",
  CHAINLINK_ETH_USD: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  CHAINLINK_BTC_USD: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",
};

describe("ERC4626PriceAdapter - Coverage Tests", function () {
  let orionConfig: MockOrionConfig;
  let vaultPriceAdapter: ERC4626PriceAdapter;
  let chainlinkAdapter: ChainlinkPriceAdapter;
  let priceRegistry: MockPriceAdapterRegistry;
  let morphoWETH: IERC4626;

  before(async function () {
    this.timeout(60000);

    // Skip if not forking mainnet
    if (!(process.env.FORK_MAINNET === "true" && process.env.MAINNET_RPC_URL)) {
      this.skip();
    }

    // Deploy mock config
    const MockOrionConfigFactory = await ethers.getContractFactory("MockOrionConfig");
    orionConfig = (await MockOrionConfigFactory.deploy(MAINNET.USDC)) as unknown as MockOrionConfig;

    // Deploy Chainlink adapter
    const ChainlinkAdapterFactory = await ethers.getContractFactory("ChainlinkPriceAdapter");
    chainlinkAdapter = (await ChainlinkAdapterFactory.deploy()) as unknown as ChainlinkPriceAdapter;

    // Configure feeds
    await chainlinkAdapter.configureFeed(
      MAINNET.WETH,
      MAINNET.CHAINLINK_ETH_USD,
      false,
      3600,
      ethers.parseUnits("1000", 8),
      ethers.parseUnits("10000", 8),
      ethers.ZeroAddress,
    );

    await chainlinkAdapter.configureFeed(
      MAINNET.WBTC,
      MAINNET.CHAINLINK_BTC_USD,
      false,
      3600,
      ethers.parseUnits("20000", 8),
      ethers.parseUnits("100000", 8),
      ethers.ZeroAddress,
    );

    // Deploy price registry
    const MockPriceAdapterRegistryFactory = await ethers.getContractFactory("MockPriceAdapterRegistry");
    priceRegistry = (await MockPriceAdapterRegistryFactory.deploy()) as unknown as MockPriceAdapterRegistry;
    await priceRegistry.setPriceAdapter(MAINNET.WETH, await chainlinkAdapter.getAddress());
    await priceRegistry.setPriceAdapter(MAINNET.WBTC, await chainlinkAdapter.getAddress());

    // Configure mock config
    await orionConfig.setPriceAdapterRegistry(await priceRegistry.getAddress());
    await orionConfig.setWhitelisted(MAINNET.WETH, true);
    await orionConfig.setWhitelisted(MAINNET.WBTC, true);

    // Deploy ERC4626 price adapter
    const ERC4626PriceAdapterFactory = await ethers.getContractFactory("ERC4626PriceAdapter");
    vaultPriceAdapter = (await ERC4626PriceAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as ERC4626PriceAdapter;

    // Get Morpho vault instance
    morphoWETH = (await ethers.getContractAt(
      "@openzeppelin/contracts/interfaces/IERC4626.sol:IERC4626",
      MAINNET.MORPHO_WETH,
    )) as unknown as IERC4626;
  });

  describe("Constructor", function () {
    it("Should reject zero address", async function () {
      const ERC4626PriceAdapterFactory = await ethers.getContractFactory("ERC4626PriceAdapter");
      await expect(ERC4626PriceAdapterFactory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        vaultPriceAdapter,
        "ZeroAddress",
      );
    });

    it("Should initialize immutables correctly", async function () {
      expect(await vaultPriceAdapter.CONFIG()).to.equal(await orionConfig.getAddress());
      expect(await vaultPriceAdapter.PRICE_REGISTRY()).to.equal(await priceRegistry.getAddress());
      expect(await vaultPriceAdapter.UNDERLYING_ASSET()).to.equal(MAINNET.USDC);
      expect(await vaultPriceAdapter.UNDERLYING_ASSET_DECIMALS()).to.equal(6);
      expect(await vaultPriceAdapter.PRICE_DECIMALS()).to.equal(10);
    });
  });

  describe("validatePriceAdapter", function () {
    it("Should validate Morpho WETH vault", async function () {
      await expect(vaultPriceAdapter.validatePriceAdapter(MAINNET.MORPHO_WETH)).to.not.be.rejected;
    });

    it("Should reject non-ERC4626 asset", async function () {
      await expect(vaultPriceAdapter.validatePriceAdapter(MAINNET.WETH)).to.be.revertedWithCustomError(
        vaultPriceAdapter,
        "InvalidAdapter",
      );
    });

    it("Should reject same-asset vault (USDC vault)", async function () {
      // Deploy a USDC vault
      const MockERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");
      const usdcVault = await MockERC4626Factory.deploy(MAINNET.USDC, "USDC Vault", "vUSDC");
      await usdcVault.waitForDeployment();

      await expect(vaultPriceAdapter.validatePriceAdapter(await usdcVault.getAddress())).to.be.revertedWithCustomError(
        vaultPriceAdapter,
        "InvalidAdapter",
      );
    });

    it("Should reject vault with no price feed for underlying", async function () {
      // Deploy vault with underlying that has no price feed (random token not whitelisted)
      const MockERC20Factory = await ethers.getContractFactory("MockUnderlyingAsset");
      const randomToken = await MockERC20Factory.deploy(18);
      await randomToken.waitForDeployment();

      const MockERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");
      const randomVault = await MockERC4626Factory.deploy(await randomToken.getAddress(), "Random Vault", "vRND");
      await randomVault.waitForDeployment();

      await expect(
        vaultPriceAdapter.validatePriceAdapter(await randomVault.getAddress()),
      ).to.be.revertedWithCustomError(vaultPriceAdapter, "InvalidAdapter");
    });
  });

  describe("getPriceData", function () {
    it("Should calculate correct composed price for Morpho WETH vault", async function () {
      const [vaultPrice, priceDecimals] = await vaultPriceAdapter.getPriceData(MAINNET.MORPHO_WETH);

      expect(priceDecimals).to.equal(28); // PRICE_DECIMALS (10) + getTokenDecimals(WETH) (18)

      const precisionAmount = 10n ** 28n; // PRICE_DECIMALS (10) + vault decimals (18)
      const wethForPrecisionShares = await morphoWETH.convertToAssets(precisionAmount);
      const wethPriceInUSD = await priceRegistry.getPrice(MAINNET.WETH);
      const priceAdapterDecimals = await orionConfig.priceAdapterDecimals();
      const expectedPrice = (wethForPrecisionShares * wethPriceInUSD) / 10n ** BigInt(priceAdapterDecimals);

      expect(vaultPrice).to.be.closeTo(expectedPrice, expectedPrice / 100n); // Within 1%
    });

    //#todo: Fix WBTC whale funding on fork
    it("Should handle vault with different underlying decimals (WBTC - 8 decimals)", async function () {
      // Deploy a WBTC vault
      const MockERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");
      const wbtcVault = await MockERC4626Factory.deploy(MAINNET.WBTC, "WBTC Vault", "vWBTC");
      await wbtcVault.waitForDeployment();

      // Register in config
      const mockConfig = await ethers.getContractAt("MockOrionConfig", await orionConfig.getAddress());
      await mockConfig.setTokenDecimals(await wbtcVault.getAddress(), 18);

      const [vaultPrice, priceDecimals] = await vaultPriceAdapter.getPriceData(await wbtcVault.getAddress());

      expect(priceDecimals).to.equal(28); // PRICE_DECIMALS (10) + getTokenDecimals(WETH) (18)
      expect(vaultPrice).to.be.gt(0);

      console.log(`  WBTC vault price: ${ethers.formatUnits(vaultPrice, 14)} USDC per share`);
    });

    it("Should handle vault appreciation (share value > 1)", async function () {
      // Morpho vault should have appreciation
      const oneShare = ethers.parseUnits("1", 18);
      const wethPerShare = await morphoWETH.convertToAssets(oneShare);

      // Share should be worth more than 1:1
      expect(wethPerShare).to.be.gte(oneShare);

      const [vaultPrice] = await vaultPriceAdapter.getPriceData(MAINNET.MORPHO_WETH);
      const wethPrice = await priceRegistry.getPrice(MAINNET.WETH);

      // Vault price should reflect the appreciation
      expect(vaultPrice).to.be.gte(wethPrice);

      console.log(`  Vault appreciation: ${ethers.formatUnits((wethPerShare * 100n) / oneShare, 2)}%`);
    });
  });
});
