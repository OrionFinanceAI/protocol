/**
 * ERC4626PriceAdapter high-supply / decimal-offset vault pricing tests.
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

// vfUSDC mainnet snapshot (Varlamore Falcon USDC)
const VF_USDC_TOTAL_ASSETS = 41_875_623_172n;
const VF_USDC_TOTAL_SUPPLY = 37_863_307_763_348_816n;
const VF_USDC_VAULT_DECIMALS = 6;

const MAINNET = {
  VF_USDC: "0xa9b23B28621CFB32e0ebf50b572aFAC671fCc17B",
};

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

  describe("mainnet vfUSDC fork", function () {
    before(function () {
      if (!(process.env.FORK_MAINNET === "true" && process.env.MAINNET_RPC_URL)) {
        this.skip();
      }
    });

    it("reports ~1.1 USDC per share for vfUSDC", async function () {
      const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

      const vault = await ethers.getContractAt(
        "@openzeppelin/contracts/interfaces/IERC4626.sol:IERC4626",
        MAINNET.VF_USDC,
      );
      const vaultToken = await ethers.getContractAt("IERC20Metadata", MAINNET.VF_USDC);

      const totalAssets = await vault.totalAssets();
      const totalSupply = await vault.totalSupply();
      const vaultDecimals = await vaultToken.decimals();

      const [deployer] = await ethers.getSigners();
      const deployed = await deployUpgradeableProtocol(deployer, USDC);
      const forkAdapter = await (
        await ethers.getContractFactory("ERC4626PriceAdapter")
      ).deploy(await deployed.orionConfig.getAddress());

      const [price] = await forkAdapter.getPriceData(MAINNET.VF_USDC);
      const underlyingPerShare = price / 10n ** BigInt(PRICE_DECIMALS);

      const naivePerShare = (totalAssets * 10n ** BigInt(vaultDecimals)) / totalSupply;
      const highPrecisionPerShare = (totalAssets * 10n ** 12n) / totalSupply;

      expect(naivePerShare).to.be.lte(1n);
      expect(underlyingPerShare).to.be.closeTo(highPrecisionPerShare, 2n);
      expect(underlyingPerShare).to.be.gt(1_000_000n);
    });
  });
});
