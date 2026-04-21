/**
 * MorphoBlueSupplyVault - Mainnet Fork Tests
 *
 * Tests the MorphoBlueSupplyVault ERC-4626 wrapper against live Morpho Blue markets.
 *
 * Test coverage:
 * 1. Vault deployment & ERC-4626 basic compliance (USDC market, same-asset)
 * 2. Vault deployment & ERC-4626 basic compliance (WETH market, cross-asset)
 * 3. ERC4626PriceAdapter integration (WETH vault priced via Chainlink)
 * 4. ERC4626ExecutionAdapter – same-asset path (USDC vault, no Uniswap hop)
 * 5. ERC4626ExecutionAdapter – cross-asset path (WETH vault, Uniswap USDC→WETH)
 * 6. Token balance invariants (vault always holds zero tokens)
 * 7. Interest accrual: totalAssets() via MorphoBalancesLib.expectedSupplyAssets
 * 8. Extended: invalid Morpho market constructor, LO-only adapter ACL, mint/withdraw paths,
 *    deposit-to-other, allowance redeem, preview consistency, revert paths, multi-step deposits
 *
 * Market IDs (verified on mainnet block 24490214 via idToMarketParams):
 *   USDC/wstETH 86% LLTV  → 0xb323495f...86cc  (70M USDC supply)
 *   WETH/wstETH 94.5%     → 0xc54d7acf...ec41  (17k WETH supply)
 *
 * Run with: FORK_MAINNET=true pnpm test test/crossAsset/MorphoBlueSupplyVault.test.ts
 */

import { expect } from "chai";
import type { Contract } from "ethers";
import { ethers, provider } from "../helpers/hh";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  ERC4626ExecutionAdapter,
  ERC4626PriceAdapter,
  UniswapV3ExecutionAdapter,
  ChainlinkPriceAdapter,
  MockOrionConfig,
  MockPriceAdapterRegistry,
  MockLiquidityOrchestrator,
  MorphoBlueSupplyVault,
  IERC20,
} from "../../typechain-types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAINNET = {
  // Tokens
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  WSTETH: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",

  // Morpho Blue singleton
  MORPHO_BLUE: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",

  // Well-known market IDs — verified at block 24490214 via Morpho.idToMarketParams()
  // USDC/wstETH 86% LLTV (loan=USDC, collateral=wstETH, ~70M USDC supply)
  USDC_WSTETH_86_MARKET_ID: "0xb323495f7e4148be5643a4ea4a8221eef163e4bccfdedc2a6f4696baacbc86cc",
  // WETH/wstETH 94.5% LLTV (loan=WETH, collateral=wstETH, ~17k WETH supply)
  WETH_WSTETH_945_MARKET_ID: "0xc54d7acf14de29e0e5527cabd7a576506870346a78a11a6762e2cca66322ec41",

  // Uniswap V3
  UNISWAP_V3_FACTORY: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  UNISWAP_ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  UNISWAP_QUOTER_V2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  WETH_FEE: 500, // 0.05% USDC/WETH pool

  // Chainlink
  CHAINLINK_ETH_USD: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",

  // Whale for USDC funding (WETH is minted by wrapping native ETH)
  USDC_WHALE: "0x37305b1cd40574e4c5ce33f8e8306be057fd7341",
};

// Minimal ABI to read Morpho Blue state without a full typechain dependency
const MORPHO_ABI = [
  "function market(bytes32 id) external view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function idToMarketParams(bytes32 id) external view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function position(bytes32 id, address user) external view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
];

/** MarketParams struct shape expected by the vault constructor */
interface MarketParams {
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: bigint;
}

const MAX_TOKEN_DUST = 10n; // max allowed residual tokens in adapters/vault

// Morpho supply-share dust after full redeem.
// Root cause: OZ ERC4626 passes assets (round-down) into MORPHO.withdraw(assets,0).
// Morpho's toSharesUp conversion leaves a negligible residual ≈ 1 micro-USDC / micro-WETH.
// At the fork block: 1M USDC shares ≈ 0.000001 USDC. We allow 10M shares as an upper bound.
const MORPHO_SHARES_DUST = 10_000_000n;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fundUsdc(recipient: string, amount: bigint, funder: SignerWithAddress): Promise<void> {
  const whale = await ethers.getImpersonatedSigner(MAINNET.USDC_WHALE);
  await funder.sendTransaction({ to: MAINNET.USDC_WHALE, value: ethers.parseEther("1") });
  const token = (await ethers.getContractAt("IERC20", MAINNET.USDC)) as unknown as IERC20;
  await token.connect(whale).transfer(recipient, amount);
}

async function fundWeth(recipient: string, amount: bigint, funder: SignerWithAddress): Promise<void> {
  // Wrap native ETH directly — WETH always accepts ETH via its deposit() fallback.
  // This avoids relying on whale accounts that may have restricted receive functions.
  const wethAbi = ["function deposit() external payable", "function transfer(address,uint256) external returns (bool)"];
  const wethContract = new ethers.Contract(MAINNET.WETH, wethAbi, funder);
  await wethContract.deposit({ value: amount });
  await wethContract.transfer(recipient, amount);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main suite
// ─────────────────────────────────────────────────────────────────────────────

describe("MorphoBlueSupplyVault", function () {
  let owner: SignerWithAddress;

  // Shared Orion infrastructure
  let orionConfig: MockOrionConfig;
  let priceRegistry: MockPriceAdapterRegistry;
  let liquidityOrchestrator: MockLiquidityOrchestrator;
  let loSigner: SignerWithAddress;

  // Adapters
  let vaultAdapter: ERC4626ExecutionAdapter;
  let uniswapAdapter: UniswapV3ExecutionAdapter;
  let chainlinkAdapter: ChainlinkPriceAdapter;
  let erc4626PriceAdapter: ERC4626PriceAdapter;

  // Tokens
  let usdc: IERC20;
  let weth: IERC20;

  // Morpho Blue market params (fetched from chain in before())
  let usdcMarketParams: MarketParams;
  let wethMarketParams: MarketParams;

  // Vaults under test
  let usdcVault: MorphoBlueSupplyVault; // loanToken = USDC (same-asset path)
  let wethVault: MorphoBlueSupplyVault; // loanToken = WETH (cross-asset path)

  // Read-only Morpho Blue interface for position/market assertions
  let morpho: Contract;

  // Decimals
  const USDC_DECIMALS = 6;
  const WETH_DECIMALS = 18;
  const SLIPPAGE = 200n; // 2% in bps

  // ─── global before ─────────────────────────────────────────────────────────

  before(async function () {
    this.timeout(120_000);

    // Skip when this isn't a fork run or the RPC endpoint isn't configured.
    if (!(process.env.FORK_MAINNET === "true" && process.env.MAINNET_RPC_URL)) {
      this.skip();
    }

    [owner] = await ethers.getSigners();
    usdc = (await ethers.getContractAt("IERC20", MAINNET.USDC)) as unknown as IERC20;
    weth = (await ethers.getContractAt("IERC20", MAINNET.WETH)) as unknown as IERC20;

    // ── Read live market params from the Morpho Blue singleton ────────────
    morpho = new ethers.Contract(MAINNET.MORPHO_BLUE, MORPHO_ABI, ethers.provider);

    const [usdcMkt, wethMkt] = await Promise.all([
      morpho.market(MAINNET.USDC_WSTETH_86_MARKET_ID),
      morpho.market(MAINNET.WETH_WSTETH_945_MARKET_ID),
    ]);

    // Skip if markets don't exist at this fork block
    if (usdcMkt.lastUpdate === 0n || wethMkt.lastUpdate === 0n) {
      console.log("  ⚠ One or more Morpho markets not found at this fork block — skipping");
      this.skip();
    }

    const [usdcRaw, wethRaw] = await Promise.all([
      morpho.idToMarketParams(MAINNET.USDC_WSTETH_86_MARKET_ID),
      morpho.idToMarketParams(MAINNET.WETH_WSTETH_945_MARKET_ID),
    ]);

    usdcMarketParams = {
      loanToken: usdcRaw.loanToken,
      collateralToken: usdcRaw.collateralToken,
      oracle: usdcRaw.oracle,
      irm: usdcRaw.irm,
      lltv: usdcRaw.lltv,
    };

    wethMarketParams = {
      loanToken: wethRaw.loanToken,
      collateralToken: wethRaw.collateralToken,
      oracle: wethRaw.oracle,
      irm: wethRaw.irm,
      lltv: wethRaw.lltv,
    };

    console.log(`  USDC market: loanToken=${usdcMarketParams.loanToken} lltv=${usdcMarketParams.lltv}`);
    console.log(`  WETH market: loanToken=${wethMarketParams.loanToken} lltv=${wethMarketParams.lltv}`);
    console.log(`  USDC market liquidity: ${ethers.formatUnits(usdcMkt.totalSupplyAssets, USDC_DECIMALS)} USDC supply`);
    console.log(`  WETH market liquidity: ${ethers.formatUnits(wethMkt.totalSupplyAssets, WETH_DECIMALS)} WETH supply`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Deployment
  // ─────────────────────────────────────────────────────────────────────────

  describe("Deployment", function () {
    it("Should deploy USDC supply vault (loanToken = USDC)", async function () {
      this.timeout(60_000);
      const VaultFactory = await ethers.getContractFactory("MorphoBlueSupplyVault");
      usdcVault = (await VaultFactory.deploy(
        MAINNET.MORPHO_BLUE,
        usdcMarketParams,
        "Orion Morpho USDC Supply",
        "omUSDC",
      )) as unknown as MorphoBlueSupplyVault;
      await usdcVault.waitForDeployment();

      expect(await usdcVault.asset()).to.equal(MAINNET.USDC);
      expect(await usdcVault.MORPHO()).to.equal(MAINNET.MORPHO_BLUE);
      expect(await usdcVault.name()).to.equal("Orion Morpho USDC Supply");
      expect(await usdcVault.symbol()).to.equal("omUSDC");
      expect(await usdcVault.decimals()).to.equal(USDC_DECIMALS);
      console.log(`  omUSDC deployed at ${await usdcVault.getAddress()}`);
    });

    it("Should deploy WETH supply vault (loanToken = WETH)", async function () {
      this.timeout(60_000);
      const VaultFactory = await ethers.getContractFactory("MorphoBlueSupplyVault");
      wethVault = (await VaultFactory.deploy(
        MAINNET.MORPHO_BLUE,
        wethMarketParams,
        "Orion Morpho WETH Supply",
        "omWETH",
      )) as unknown as MorphoBlueSupplyVault;
      await wethVault.waitForDeployment();

      expect(await wethVault.asset()).to.equal(MAINNET.WETH);
      expect(await wethVault.MORPHO()).to.equal(MAINNET.MORPHO_BLUE);
      expect(await wethVault.decimals()).to.equal(WETH_DECIMALS);
      console.log(`  omWETH deployed at ${await wethVault.getAddress()}`);
    });

    it("Should reject zero Morpho address", async function () {
      const VaultFactory = await ethers.getContractFactory("MorphoBlueSupplyVault");
      await expect(VaultFactory.deploy(ethers.ZeroAddress, usdcMarketParams, "X", "X")).to.be.revertedWithCustomError(
        VaultFactory,
        "ZeroAddress",
      );
    });

    it("Should compute correct MARKET_ID matching known market ID", async function () {
      const storedId = await usdcVault.MARKET_ID();
      expect(storedId.toLowerCase()).to.equal(MAINNET.USDC_WSTETH_86_MARKET_ID.toLowerCase());

      const storedIdWeth = await wethVault.MARKET_ID();
      expect(storedIdWeth.toLowerCase()).to.equal(MAINNET.WETH_WSTETH_945_MARKET_ID.toLowerCase());
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. ERC-4626 Compliance — USDC vault (direct, no adapters)
  // ─────────────────────────────────────────────────────────────────────────

  describe("ERC-4626 Compliance — USDC vault (direct deposit/redeem)", function () {
    const DEPOSIT_AMOUNT = ethers.parseUnits("1000", 6); // 1 000 USDC
    let depositor: SignerWithAddress;
    let sharesMinted: bigint;

    before(async function () {
      [, depositor] = await ethers.getSigners();
      await fundUsdc(depositor.address, DEPOSIT_AMOUNT * 2n, owner);
    });

    it("Fresh vault has zero totalAssets and zero totalSupply", async function () {
      expect(await usdcVault.totalAssets()).to.equal(0n);
      expect(await usdcVault.totalSupply()).to.equal(0n);
    });

    it("previewDeposit returns 1:1 for fresh vault (no existing shares)", async function () {
      const preview = await usdcVault.previewDeposit(DEPOSIT_AMOUNT);
      // First depositor gets exactly assets shares (OZ ERC4626, no virtual offset in this impl)
      expect(preview).to.equal(DEPOSIT_AMOUNT);
    });

    it("deposit() mints correct shares and leaves zero USDC in vault", async function () {
      this.timeout(30_000);
      await usdc.connect(depositor).approve(await usdcVault.getAddress(), DEPOSIT_AMOUNT);

      const tx = await usdcVault.connect(depositor).deposit(DEPOSIT_AMOUNT, depositor.address);
      const receipt = await tx.wait();
      console.log(`  Deposit gas: ${receipt!.gasUsed.toLocaleString()}`);

      sharesMinted = await usdcVault.balanceOf(depositor.address);
      expect(sharesMinted).to.be.gt(0n);

      // Vault must hold no USDC — all forwarded to Morpho
      const vaultUSDCBalance = await usdc.balanceOf(await usdcVault.getAddress());
      expect(vaultUSDCBalance).to.equal(0n);

      // ── Morpho-side assertion: vault now has supply shares in the market ──
      const posAfterDeposit = await morpho.position(MAINNET.USDC_WSTETH_86_MARKET_ID, await usdcVault.getAddress());
      expect(posAfterDeposit.supplyShares, "vault must hold Morpho supply shares after deposit").to.be.gt(0n);

      console.log(`  Shares minted: ${ethers.formatUnits(sharesMinted, USDC_DECIMALS)}`);
      console.log(`  Morpho supplyShares: ${posAfterDeposit.supplyShares}`);
    });

    it("totalAssets() reflects deposited amount via MorphoBalancesLib", async function () {
      const total = await usdcVault.totalAssets();
      // Should be very close to DEPOSIT_AMOUNT (interest ≈ 0 in same block)
      expect(total).to.be.closeTo(DEPOSIT_AMOUNT, DEPOSIT_AMOUNT / 1000n); // within 0.1%
      console.log(`  totalAssets(): ${ethers.formatUnits(total, USDC_DECIMALS)} USDC`);
    });

    it("convertToAssets(shares) ≈ deposit amount (interest-adjusted)", async function () {
      const assets = await usdcVault.convertToAssets(sharesMinted);
      expect(assets).to.be.closeTo(DEPOSIT_AMOUNT, DEPOSIT_AMOUNT / 1000n);
    });

    it("maxRedeem(depositor) == share balance; maxWithdraw(depositor) ≈ deposit amount", async function () {
      // Standard OZ ERC4626 maxRedeem returns balanceOf(owner)
      const maxRedeemable = await usdcVault.maxRedeem(depositor.address);
      expect(maxRedeemable).to.equal(sharesMinted);

      // maxWithdraw = convertToAssets(maxRedeem)
      const maxWithdrawable = await usdcVault.maxWithdraw(depositor.address);
      expect(maxWithdrawable).to.be.closeTo(DEPOSIT_AMOUNT, DEPOSIT_AMOUNT / 500n);

      // Sanity: maxWithdraw should not exceed total available market supply
      // (available = totalSupplyAssets - totalBorrowAssets)
      const mkt = await morpho.market(MAINNET.USDC_WSTETH_86_MARKET_ID);
      const available = mkt.totalSupplyAssets - mkt.totalBorrowAssets;
      expect(maxWithdrawable).to.be.lte(available);

      console.log(`  maxRedeem: ${ethers.formatUnits(maxRedeemable, USDC_DECIMALS)} shares`);
      console.log(`  maxWithdraw: ${ethers.formatUnits(maxWithdrawable, USDC_DECIMALS)} USDC`);
      console.log(`  market available: ${ethers.formatUnits(available, USDC_DECIMALS)} USDC`);
    });

    it("redeem() burns shares and sends USDC directly to receiver (never via vault)", async function () {
      this.timeout(30_000);
      const usdcBefore = await usdc.balanceOf(depositor.address);

      await usdcVault.connect(depositor).redeem(sharesMinted, depositor.address, depositor.address);

      const usdcAfter = await usdc.balanceOf(depositor.address);
      const received = usdcAfter - usdcBefore;

      expect(received).to.be.closeTo(DEPOSIT_AMOUNT, DEPOSIT_AMOUNT / 500n); // within 0.2%

      // Vault holds zero after redeem
      const vaultBal = await usdc.balanceOf(await usdcVault.getAddress());
      expect(vaultBal).to.equal(0n);

      const sharesAfter = await usdcVault.balanceOf(depositor.address);
      expect(sharesAfter).to.equal(0n);

      // ── Morpho-side assertion: vault's Morpho position is fully (or near-fully) cleared ──
      // Note: OZ ERC4626 passes assets (rounded down) into MORPHO.withdraw(assets,0).
      // Morpho converts back to shares rounding UP, so a negligible dust (<MORPHO_SHARES_DUST)
      // may remain. This corresponds to ≪1 micro-USDC and is an acceptable rounding artefact.
      const posAfterRedeem = await morpho.position(MAINNET.USDC_WSTETH_86_MARKET_ID, await usdcVault.getAddress());
      expect(posAfterRedeem.supplyShares, "vault's Morpho supply dust must be below threshold").to.be.lte(
        MORPHO_SHARES_DUST,
      );
      console.log(`  Morpho supplyShares dust after full exit: ${posAfterRedeem.supplyShares}`);

      console.log(`  USDC received: ${ethers.formatUnits(received, USDC_DECIMALS)} USDC`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. ERC-4626 Compliance — WETH vault (direct deposit/redeem)
  // ─────────────────────────────────────────────────────────────────────────

  describe("ERC-4626 Compliance — WETH vault (direct deposit/redeem)", function () {
    const DEPOSIT_WETH = ethers.parseUnits("0.5", 18); // 0.5 WETH
    let depositor: SignerWithAddress;
    let sharesMinted: bigint;

    before(async function () {
      [, , depositor] = await ethers.getSigners();
      await fundWeth(depositor.address, DEPOSIT_WETH * 2n, owner);
    });

    it("Fresh WETH vault has zero totalAssets", async function () {
      expect(await wethVault.totalAssets()).to.equal(0n);
    });

    it("deposit() forwards WETH to Morpho and mints shares", async function () {
      this.timeout(30_000);
      await weth.connect(depositor).approve(await wethVault.getAddress(), DEPOSIT_WETH);

      await wethVault.connect(depositor).deposit(DEPOSIT_WETH, depositor.address);

      sharesMinted = await wethVault.balanceOf(depositor.address);
      expect(sharesMinted).to.be.gt(0n);

      // Vault must hold zero WETH
      const vaultWETH = await weth.balanceOf(await wethVault.getAddress());
      expect(vaultWETH).to.equal(0n);

      const totalAssets = await wethVault.totalAssets();
      expect(totalAssets).to.be.closeTo(DEPOSIT_WETH, DEPOSIT_WETH / 1000n);

      // ── Morpho-side assertion ──
      const posAfterDeposit = await morpho.position(MAINNET.WETH_WSTETH_945_MARKET_ID, await wethVault.getAddress());
      expect(posAfterDeposit.supplyShares, "vault must hold Morpho supply shares after deposit").to.be.gt(0n);

      console.log(`  WETH shares minted: ${ethers.formatUnits(sharesMinted, WETH_DECIMALS)}`);
      console.log(`  totalAssets: ${ethers.formatUnits(totalAssets, WETH_DECIMALS)} WETH`);
      console.log(`  Morpho supplyShares: ${posAfterDeposit.supplyShares}`);
    });

    it("maxRedeem/maxWithdraw are sensible after deposit", async function () {
      const maxRedeemable = await wethVault.maxRedeem(depositor.address);
      expect(maxRedeemable).to.equal(sharesMinted);

      const maxWithdrawable = await wethVault.maxWithdraw(depositor.address);
      expect(maxWithdrawable).to.be.closeTo(DEPOSIT_WETH, DEPOSIT_WETH / 500n);

      // Should not exceed available market liquidity
      const mkt = await morpho.market(MAINNET.WETH_WSTETH_945_MARKET_ID);
      const available = mkt.totalSupplyAssets - mkt.totalBorrowAssets;
      expect(maxWithdrawable).to.be.lte(available);

      console.log(`  maxRedeem: ${ethers.formatUnits(maxRedeemable, WETH_DECIMALS)} shares`);
      console.log(`  maxWithdraw: ${ethers.formatUnits(maxWithdrawable, WETH_DECIMALS)} WETH`);
      console.log(`  market available: ${ethers.formatUnits(available, WETH_DECIMALS)} WETH`);
    });

    it("redeem() returns WETH directly from Morpho to receiver (no vault holding)", async function () {
      this.timeout(30_000);
      const wethBefore = await weth.balanceOf(depositor.address);

      await wethVault.connect(depositor).redeem(sharesMinted, depositor.address, depositor.address);

      const wethAfter = await weth.balanceOf(depositor.address);
      const received = wethAfter - wethBefore;

      expect(received).to.be.closeTo(DEPOSIT_WETH, DEPOSIT_WETH / 500n); // within 0.2%
      expect(await weth.balanceOf(await wethVault.getAddress())).to.equal(0n);

      // ── Morpho-side assertion: position near-zero after full redeem ──
      // Sub-share dust may remain due to OZ round-down vs Morpho round-up (see MORPHO_SHARES_DUST).
      const posAfterRedeem = await morpho.position(MAINNET.WETH_WSTETH_945_MARKET_ID, await wethVault.getAddress());
      expect(posAfterRedeem.supplyShares, "vault's Morpho supply dust must be below threshold").to.be.lte(
        MORPHO_SHARES_DUST,
      );
      console.log(`  Morpho supplyShares dust after full exit: ${posAfterRedeem.supplyShares}`);

      console.log(`  WETH received: ${ethers.formatUnits(received, WETH_DECIMALS)} WETH`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3b. Partial redeem — 40% / 60% split
  // ─────────────────────────────────────────────────────────────────────────

  describe("Partial redeem — 40% / 60% split (USDC vault)", function () {
    const FULL_DEPOSIT = ethers.parseUnits("2000", 6); // 2 000 USDC
    let partialDepositor: SignerWithAddress;
    let totalShares: bigint;
    let morphoSharesBefore: bigint;

    before(async function () {
      [, , , , partialDepositor] = await ethers.getSigners();
      await fundUsdc(partialDepositor.address, FULL_DEPOSIT * 2n, owner);

      await usdc.connect(partialDepositor).approve(await usdcVault.getAddress(), FULL_DEPOSIT);
      await usdcVault.connect(partialDepositor).deposit(FULL_DEPOSIT, partialDepositor.address);
      totalShares = await usdcVault.balanceOf(partialDepositor.address);

      const posInit = await morpho.position(MAINNET.USDC_WSTETH_86_MARKET_ID, await usdcVault.getAddress());
      morphoSharesBefore = posInit.supplyShares;
    });

    it("Redeem 40%: correct USDC received and shares remaining", async function () {
      this.timeout(30_000);
      const fortyPct = (totalShares * 40n) / 100n;
      const expectedUSDC = (FULL_DEPOSIT * 40n) / 100n;

      const usdcBefore = await usdc.balanceOf(partialDepositor.address);
      await usdcVault.connect(partialDepositor).redeem(fortyPct, partialDepositor.address, partialDepositor.address);
      const usdcAfter = await usdc.balanceOf(partialDepositor.address);

      const received = usdcAfter - usdcBefore;
      expect(received).to.be.closeTo(expectedUSDC, expectedUSDC / 200n); // within 0.5%

      const remainingShares = await usdcVault.balanceOf(partialDepositor.address);
      expect(remainingShares).to.equal(totalShares - fortyPct);

      // Vault holds no USDC
      expect(await usdc.balanceOf(await usdcVault.getAddress())).to.equal(0n);

      // Morpho position reduced but non-zero
      const posAfter40 = await morpho.position(MAINNET.USDC_WSTETH_86_MARKET_ID, await usdcVault.getAddress());
      expect(posAfter40.supplyShares).to.be.lt(morphoSharesBefore);
      expect(posAfter40.supplyShares).to.be.gt(0n);

      console.log(`  40% redeemed: ${ethers.formatUnits(received, 6)} USDC`);
      console.log(`  Remaining shares: ${ethers.formatUnits(remainingShares, 6)}`);
      console.log(`  Morpho shares remaining: ${posAfter40.supplyShares}`);
    });

    it("Redeem remaining 60%: full exit, Morpho position zeroed", async function () {
      this.timeout(30_000);
      const remainingShares = await usdcVault.balanceOf(partialDepositor.address);
      const expectedUSDC = (FULL_DEPOSIT * 60n) / 100n;

      const usdcBefore = await usdc.balanceOf(partialDepositor.address);
      await usdcVault
        .connect(partialDepositor)
        .redeem(remainingShares, partialDepositor.address, partialDepositor.address);
      const usdcAfter = await usdc.balanceOf(partialDepositor.address);

      expect(usdcAfter - usdcBefore).to.be.closeTo(expectedUSDC, expectedUSDC / 200n);
      expect(await usdcVault.balanceOf(partialDepositor.address)).to.equal(0n);

      // Morpho position should be near-zero (sub-micro-USDC dust allowed, see MORPHO_SHARES_DUST)
      const posFinal = await morpho.position(MAINNET.USDC_WSTETH_86_MARKET_ID, await usdcVault.getAddress());
      expect(posFinal.supplyShares, "Morpho position dust must be below threshold after full exit").to.be.lte(
        MORPHO_SHARES_DUST,
      );
      console.log(`  Morpho supplyShares dust after 60% exit: ${posFinal.supplyShares}`);

      console.log(`  60% redeemed: ${ethers.formatUnits(usdcAfter - usdcBefore, 6)} USDC`);
    });

    it("totalAssets() and totalSupply() settle to zero after full exit", async function () {
      // After the two partial redeems above, this vault's totalSupply should be ~0
      // (other tests may have deposits, so we check this depositor's slice, not the global total)
      const sharesLeft = await usdcVault.balanceOf(partialDepositor.address);
      expect(sharesLeft).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3c. Multi-depositor fairness — proportional share issuance
  // ─────────────────────────────────────────────────────────────────────────

  describe("Multi-depositor fairness (USDC vault)", function () {
    let userA: SignerWithAddress;
    let userB: SignerWithAddress;
    const DEPOSIT_A = ethers.parseUnits("1000", 6); // 1 000 USDC
    const DEPOSIT_B = ethers.parseUnits("2000", 6); // 2 000 USDC
    let sharesA: bigint;
    let sharesB: bigint;

    before(async function () {
      // Use fresh signers not touched by other describes
      const signers = await ethers.getSigners();
      userA = signers[5];
      userB = signers[6];

      await fundUsdc(userA.address, DEPOSIT_A * 2n, owner);
      await fundUsdc(userB.address, DEPOSIT_B * 2n, owner);
    });

    it("User A deposits 1000 USDC — receives shares proportional to pool", async function () {
      this.timeout(30_000);
      await usdc.connect(userA).approve(await usdcVault.getAddress(), DEPOSIT_A);
      await usdcVault.connect(userA).deposit(DEPOSIT_A, userA.address);
      sharesA = await usdcVault.balanceOf(userA.address);
      expect(sharesA).to.be.gt(0n);
      console.log(`  User A shares: ${ethers.formatUnits(sharesA, 6)}`);
    });

    it("User B deposits 2000 USDC — receives ~2× shares of user A", async function () {
      this.timeout(30_000);
      await usdc.connect(userB).approve(await usdcVault.getAddress(), DEPOSIT_B);
      await usdcVault.connect(userB).deposit(DEPOSIT_B, userB.address);
      sharesB = await usdcVault.balanceOf(userB.address);
      expect(sharesB).to.be.gt(0n);

      // B deposited 2× more, should get proportionally ~2× shares
      // Allow 1% tolerance for any interest accrued between the two deposits
      const ratio = (sharesB * 1000n) / sharesA;
      expect(ratio).to.be.gte(1990n); // ≥ 1.99×
      expect(ratio).to.be.lte(2010n); // ≤ 2.01×

      console.log(`  User B shares: ${ethers.formatUnits(sharesB, 6)}`);
      console.log(`  B / A ratio: ${Number(ratio) / 1000}`);
    });

    it("Both users redeem — each recovers their proportional USDC (+/- Morpho fee)", async function () {
      this.timeout(60_000);
      const usdcABefore = await usdc.balanceOf(userA.address);
      const usdcBBefore = await usdc.balanceOf(userB.address);

      await usdcVault.connect(userA).redeem(sharesA, userA.address, userA.address);
      await usdcVault.connect(userB).redeem(sharesB, userB.address, userB.address);

      const recoveredA = (await usdc.balanceOf(userA.address)) - usdcABefore;
      const recoveredB = (await usdc.balanceOf(userB.address)) - usdcBBefore;

      // Each should recover close to what they deposited (same-block, near-zero interest)
      expect(recoveredA).to.be.closeTo(DEPOSIT_A, DEPOSIT_A / 200n); // within 0.5%
      expect(recoveredB).to.be.closeTo(DEPOSIT_B, DEPOSIT_B / 200n); // within 0.5%

      // B recovers ~2× A
      const recoverRatio = (recoveredB * 1000n) / recoveredA;
      expect(recoverRatio).to.be.gte(1980n);
      expect(recoverRatio).to.be.lte(2020n);

      console.log(`  A recovered: ${ethers.formatUnits(recoveredA, 6)} USDC`);
      console.log(`  B recovered: ${ethers.formatUnits(recoveredB, 6)} USDC`);
      console.log(`  B/A recover ratio: ${Number(recoverRatio) / 1000}`);
    });

    it("convertToShares and convertToAssets remain approximately inverse", async function () {
      // Verify the two conversion functions are mutual inverses to within rounding.
      // (First-depositor distortion is covered by the proportional share issuance tests above.)
      const oneUSDC = ethers.parseUnits("1", 6);
      const sharesToAssets = await usdcVault.convertToAssets(oneUSDC);
      const assetsToShares = await usdcVault.convertToShares(oneUSDC);

      // These should be approximate inverses
      const roundTrip = await usdcVault.convertToAssets(assetsToShares);
      // round-trip: assets → shares → assets should recover ≥ 99.9% (rounding down)
      expect(roundTrip).to.be.gte((oneUSDC * 999n) / 1000n);
      console.log(`  1 USDC → ${assetsToShares} shares → ${sharesToAssets} assets`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Deploy shared Orion adapter infrastructure
  // ─────────────────────────────────────────────────────────────────────────

  describe("Orion Adapter Infrastructure Setup", function () {
    it("Should deploy MockOrionConfig, LO, adapters", async function () {
      this.timeout(60_000);

      // MockOrionConfig with USDC as underlying
      const ConfigFactory = await ethers.getContractFactory("MockOrionConfig");
      orionConfig = (await ConfigFactory.deploy(MAINNET.USDC)) as unknown as MockOrionConfig;

      // MockPriceAdapterRegistry
      const RegistryFactory = await ethers.getContractFactory("MockPriceAdapterRegistry");
      priceRegistry = (await RegistryFactory.deploy()) as unknown as MockPriceAdapterRegistry;

      // MockLiquidityOrchestrator
      const LOFactory = await ethers.getContractFactory("MockLiquidityOrchestrator");
      liquidityOrchestrator = (await LOFactory.deploy(
        await orionConfig.getAddress(),
      )) as unknown as MockLiquidityOrchestrator;

      // Wire config
      await orionConfig.setPriceAdapterRegistry(await priceRegistry.getAddress());
      await orionConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());

      // Chainlink adapter for WETH pricing
      const ChainlinkFactory = await ethers.getContractFactory("ChainlinkPriceAdapter");
      chainlinkAdapter = (await ChainlinkFactory.deploy()) as unknown as ChainlinkPriceAdapter;
      await chainlinkAdapter.configureFeed(
        MAINNET.WETH,
        MAINNET.CHAINLINK_ETH_USD,
        false,
        3600,
        ethers.parseUnits("500", 8),
        ethers.parseUnits("20000", 8),
        ethers.ZeroAddress,
      );

      // Register WETH in price registry & whitelist
      await priceRegistry.setPriceAdapter(MAINNET.WETH, await chainlinkAdapter.getAddress());
      await orionConfig.setWhitelisted(MAINNET.WETH, true);

      // ERC4626PriceAdapter
      const VaultPriceFactory = await ethers.getContractFactory("ERC4626PriceAdapter");
      erc4626PriceAdapter = (await VaultPriceFactory.deploy(
        await orionConfig.getAddress(),
      )) as unknown as ERC4626PriceAdapter;

      // UniswapV3ExecutionAdapter (handles USDC ↔ WETH swaps)
      const UniswapFactory = await ethers.getContractFactory("UniswapV3ExecutionAdapter");
      uniswapAdapter = (await UniswapFactory.deploy(
        owner.address,
        MAINNET.UNISWAP_V3_FACTORY,
        MAINNET.UNISWAP_ROUTER,
        MAINNET.UNISWAP_QUOTER_V2,
        await orionConfig.getAddress(),
      )) as unknown as UniswapV3ExecutionAdapter;
      await uniswapAdapter.setAssetFee(MAINNET.WETH, MAINNET.WETH_FEE);

      // ERC4626ExecutionAdapter (handles vault mint/redeem)
      const VaultExecFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
      vaultAdapter = (await VaultExecFactory.deploy(
        await orionConfig.getAddress(),
      )) as unknown as ERC4626ExecutionAdapter;

      // Register adapters in LO
      await liquidityOrchestrator.setExecutionAdapter(MAINNET.WETH, await uniswapAdapter.getAddress());
      await liquidityOrchestrator.setExecutionAdapter(await wethVault.getAddress(), await vaultAdapter.getAddress());
      await liquidityOrchestrator.setExecutionAdapter(await usdcVault.getAddress(), await vaultAdapter.getAddress());

      // Token decimals for MockOrionConfig validation
      // USDC vault: shares have 6 decimals (inherited from USDC)
      await orionConfig.setTokenDecimals(await usdcVault.getAddress(), USDC_DECIMALS);
      await orionConfig.setTokenDecimals(MAINNET.USDC, USDC_DECIMALS);
      // WETH vault: shares have 18 decimals (default, no explicit set needed)

      // Impersonate LO as caller for adapter interactions
      const loAddress = await liquidityOrchestrator.getAddress();
      loSigner = await ethers.getImpersonatedSigner(loAddress);
      await owner.sendTransaction({ to: loAddress, value: ethers.parseEther("10") });

      // Fund LO with tokens for tests
      await fundUsdc(loAddress, ethers.parseUnits("200000", USDC_DECIMALS), owner);
      console.log(`  LO USDC balance: ${ethers.formatUnits(await usdc.balanceOf(loAddress), USDC_DECIMALS)}`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. ERC4626PriceAdapter integration — WETH vault
  // ─────────────────────────────────────────────────────────────────────────

  describe("ERC4626PriceAdapter — WETH supply vault", function () {
    it("validatePriceAdapter passes for WETH vault (loanToken is whitelisted)", async function () {
      await erc4626PriceAdapter.validatePriceAdapter(await wethVault.getAddress());
    });

    it("validatePriceAdapter rejects USDC vault (loanToken == underlying, not whitelisted)", async function () {
      await expect(
        erc4626PriceAdapter.validatePriceAdapter(await usdcVault.getAddress()),
      ).to.be.revertedWithCustomError(erc4626PriceAdapter, "InvalidAdapter");
    });

    it("getPriceData returns sensible WETH vault price", async function () {
      // Seed WETH vault with a small deposit so totalAssets > 0 (fresh vault → 1:1 pricing still works)
      const seedDepositor = (await ethers.getSigners())[3];
      await fundWeth(seedDepositor.address, ethers.parseUnits("0.1", 18), owner);
      await weth.connect(seedDepositor).approve(await wethVault.getAddress(), ethers.parseUnits("0.1", 18));
      await wethVault.connect(seedDepositor).deposit(ethers.parseUnits("0.1", 18), seedDepositor.address);

      const [price, decimals] = await erc4626PriceAdapter.getPriceData(await wethVault.getAddress());
      // priceDecimals = PRICE_DECIMALS(10) + getTokenDecimals(WETH)(18) = 28
      expect(decimals).to.equal(28);
      expect(price).to.be.gt(0n);

      // Cross-check: price should be close to spot WETH price (in USDC units × 10^22)
      const [wethPrice] = await chainlinkAdapter.getPriceData(MAINNET.WETH);
      // WETH vault share price ≥ WETH price (share accrues interest)
      expect(price).to.be.gte(wethPrice);

      const priceInUSD = price / 10n ** 22n;
      console.log(`  omWETH price: ~$${priceInUSD} per share`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. ERC4626ExecutionAdapter — USDC vault (same-asset path)
  // ─────────────────────────────────────────────────────────────────────────

  describe("ERC4626ExecutionAdapter — USDC vault (same-asset: no Uniswap hop)", function () {
    const SHARES_TO_BUY = ethers.parseUnits("500", USDC_DECIMALS); // 500 omUSDC shares

    it("validateExecutionAdapter passes with correct decimals configured", async function () {
      await vaultAdapter.validateExecutionAdapter(await usdcVault.getAddress());
    });

    it("buy(): USDC → omUSDC shares (no swap, direct vault.mint)", async function () {
      this.timeout(30_000);
      const previewCost = await vaultAdapter.previewBuy.staticCall(await usdcVault.getAddress(), SHARES_TO_BUY);
      expect(previewCost).to.be.gt(0n);

      const maxUSDC = (previewCost * (10000n + SLIPPAGE)) / 10000n;
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);

      const usdcBefore = await usdc.balanceOf(loSigner.address);
      const tx = await vaultAdapter.connect(loSigner).buy(await usdcVault.getAddress(), SHARES_TO_BUY);
      const receipt = await tx.wait();
      const usdcAfter = await usdc.balanceOf(loSigner.address);

      const sharesReceived = await usdcVault.balanceOf(loSigner.address);
      expect(sharesReceived).to.equal(SHARES_TO_BUY);

      const spent = usdcBefore - usdcAfter;
      expect(spent).to.be.gt(0n);
      expect(spent).to.be.lte(maxUSDC);

      // Vault must hold zero USDC throughout (all forwarded to Morpho)
      expect(await usdc.balanceOf(await usdcVault.getAddress())).to.equal(0n);
      // Adapter must hold zero USDC
      expect(await usdc.balanceOf(await vaultAdapter.getAddress())).to.be.lt(MAX_TOKEN_DUST);

      console.log(`  buy gas: ${receipt!.gasUsed.toLocaleString()}`);
      console.log(`  USDC spent: ${ethers.formatUnits(spent, USDC_DECIMALS)}`);
      console.log(`  Shares received: ${ethers.formatUnits(sharesReceived, USDC_DECIMALS)}`);
    });

    it("sell(): omUSDC shares → USDC (no swap, direct vault.redeem)", async function () {
      this.timeout(30_000);
      const sharesToSell = await usdcVault.balanceOf(loSigner.address);
      expect(sharesToSell).to.be.gt(0n);

      await usdcVault.connect(loSigner).approve(await vaultAdapter.getAddress(), sharesToSell);

      const usdcBefore = await usdc.balanceOf(loSigner.address);
      const tx = await vaultAdapter.connect(loSigner).sell(await usdcVault.getAddress(), sharesToSell);
      const receipt = await tx.wait();
      const usdcAfter = await usdc.balanceOf(loSigner.address);

      const received = usdcAfter - usdcBefore;
      expect(received).to.be.gt(0n);
      expect(await usdcVault.balanceOf(loSigner.address)).to.equal(0n);

      // Vault and adapter hold zero tokens after sell
      expect(await usdc.balanceOf(await usdcVault.getAddress())).to.equal(0n);
      expect(await usdc.balanceOf(await vaultAdapter.getAddress())).to.be.lt(MAX_TOKEN_DUST);

      console.log(`  sell gas: ${receipt!.gasUsed.toLocaleString()}`);
      console.log(`  USDC received: ${ethers.formatUnits(received, USDC_DECIMALS)}`);
    });

    it("buy/sell round-trip returns ≥ 99.5% of original USDC (slippage within Morpho only)", async function () {
      this.timeout(60_000);
      const ROUND_TRIP_USDC = ethers.parseUnits("1000", USDC_DECIMALS);
      const previewShares = await usdcVault.previewDeposit(ROUND_TRIP_USDC);

      const maxAllowance = (ROUND_TRIP_USDC * 10200n) / 10000n;
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxAllowance);
      const usdcBefore = await usdc.balanceOf(loSigner.address);

      await vaultAdapter.connect(loSigner).buy(await usdcVault.getAddress(), previewShares);
      const sharesHeld = await usdcVault.balanceOf(loSigner.address);
      expect(sharesHeld).to.equal(previewShares);

      await usdcVault.connect(loSigner).approve(await vaultAdapter.getAddress(), sharesHeld);
      await vaultAdapter.connect(loSigner).sell(await usdcVault.getAddress(), sharesHeld);

      const usdcAfter = await usdc.balanceOf(loSigner.address);
      const roundTripUSDC = usdcAfter - (usdcBefore - ROUND_TRIP_USDC);

      // With same-asset vault, round-trip loss = only Morpho protocol fee (typically 0 in tests)
      expect(roundTripUSDC).to.be.gte((ROUND_TRIP_USDC * 9950n) / 10000n);
      console.log(`  Round-trip returned: ${ethers.formatUnits(roundTripUSDC, USDC_DECIMALS)} USDC`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. ERC4626ExecutionAdapter — WETH vault (cross-asset path)
  // ─────────────────────────────────────────────────────────────────────────

  describe("ERC4626ExecutionAdapter — WETH vault (cross-asset: USDC→WETH via Uniswap)", function () {
    const SHARES_TO_BUY = ethers.parseUnits("0.5", WETH_DECIMALS); // 0.5 omWETH shares

    it("validateExecutionAdapter passes for WETH vault", async function () {
      await vaultAdapter.validateExecutionAdapter(await wethVault.getAddress());
    });

    it("previewBuy returns sensible USDC cost for 0.5 omWETH shares", async function () {
      const cost = await vaultAdapter.previewBuy.staticCall(await wethVault.getAddress(), SHARES_TO_BUY);
      expect(cost).to.be.gt(0n);
      // 0.5 WETH ≈ $1000–$10000 USDC at any reasonable ETH price
      expect(cost).to.be.gt(ethers.parseUnits("500", USDC_DECIMALS));
      expect(cost).to.be.lt(ethers.parseUnits("20000", USDC_DECIMALS));
      console.log(`  previewBuy(0.5 omWETH): ${ethers.formatUnits(cost, USDC_DECIMALS)} USDC`);
    });

    it("buy(): USDC → Uniswap(USDC→WETH) → vault.mint → omWETH shares", async function () {
      this.timeout(60_000);
      const previewCost = await vaultAdapter.previewBuy.staticCall(await wethVault.getAddress(), SHARES_TO_BUY);
      const maxUSDC = (previewCost * (10000n + SLIPPAGE)) / 10000n;

      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);

      const usdcBefore = await usdc.balanceOf(loSigner.address);
      const tx = await vaultAdapter.connect(loSigner).buy(await wethVault.getAddress(), SHARES_TO_BUY);
      const receipt = await tx.wait();
      const usdcAfter = await usdc.balanceOf(loSigner.address);

      const sharesReceived = await wethVault.balanceOf(loSigner.address);
      expect(sharesReceived).to.equal(SHARES_TO_BUY); // exact shares, no drift

      const spent = usdcBefore - usdcAfter;
      expect(spent).to.be.gt(0n);
      expect(spent).to.be.lte(maxUSDC);

      // WETH vault holds zero WETH — all in Morpho
      expect(await weth.balanceOf(await wethVault.getAddress())).to.equal(0n);
      // Adapter holds zero WETH and zero USDC
      expect(await weth.balanceOf(await vaultAdapter.getAddress())).to.be.lt(MAX_TOKEN_DUST);
      expect(await usdc.balanceOf(await vaultAdapter.getAddress())).to.be.lt(MAX_TOKEN_DUST);

      console.log(`  buy gas: ${receipt!.gasUsed.toLocaleString()}`);
      console.log(`  USDC spent: ${ethers.formatUnits(spent, USDC_DECIMALS)}`);
      console.log(`  omWETH shares received: ${ethers.formatUnits(sharesReceived, WETH_DECIMALS)}`);
    });

    it("sell(): omWETH shares → vault.redeem → Uniswap(WETH→USDC) → USDC", async function () {
      this.timeout(60_000);
      const sharesToSell = await wethVault.balanceOf(loSigner.address);
      expect(sharesToSell).to.be.gt(0n);

      await wethVault.connect(loSigner).approve(await vaultAdapter.getAddress(), sharesToSell);

      const usdcBefore = await usdc.balanceOf(loSigner.address);
      const tx = await vaultAdapter.connect(loSigner).sell(await wethVault.getAddress(), sharesToSell);
      const receipt = await tx.wait();
      const usdcAfter = await usdc.balanceOf(loSigner.address);

      const received = usdcAfter - usdcBefore;
      expect(received).to.be.gt(0n);
      expect(await wethVault.balanceOf(loSigner.address)).to.equal(0n);

      // WETH vault must hold zero after sell
      expect(await weth.balanceOf(await wethVault.getAddress())).to.equal(0n);
      // Adapter must hold zero
      expect(await weth.balanceOf(await vaultAdapter.getAddress())).to.be.lt(MAX_TOKEN_DUST);
      expect(await usdc.balanceOf(await vaultAdapter.getAddress())).to.be.lt(MAX_TOKEN_DUST);

      console.log(`  sell gas: ${receipt!.gasUsed.toLocaleString()}`);
      console.log(`  USDC received: ${ethers.formatUnits(received, USDC_DECIMALS)}`);
    });

    it("Slippage guard: buy with 10x underpriced allowance reverts with ERC20 transfer error", async function () {
      // The adapter calls safeTransferFrom(LO, adapter, previewedAmount).
      // If LO's allowance to the adapter is insufficient, the ERC20 reverts.
      // We assert it reverts (exact error is USDC-implementation-specific) and that
      // no vault shares are minted to the LO — i.e. the entire tx rolls back.
      const previewCost = await vaultAdapter.previewBuy.staticCall(await wethVault.getAddress(), SHARES_TO_BUY);
      const tooLow = previewCost / 10n;

      const sharesBefore = await wethVault.balanceOf(loSigner.address);
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), tooLow);

      await expect(vaultAdapter.connect(loSigner).buy(await wethVault.getAddress(), SHARES_TO_BUY)).to.be.rejected;

      // Transaction rolled back — no shares leaked
      expect(await wethVault.balanceOf(loSigner.address)).to.equal(sharesBefore);
    });

    it("buy(): zero shares reverts with AmountMustBeGreaterThanZero custom error", async function () {
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), ethers.parseUnits("1000", USDC_DECIMALS));
      await expect(vaultAdapter.connect(loSigner).buy(await wethVault.getAddress(), 0n)).to.be.revertedWithCustomError(
        vaultAdapter,
        "AmountMustBeGreaterThanZero",
      );
    });

    it("sell(): zero shares reverts with AmountMustBeGreaterThanZero custom error", async function () {
      await expect(vaultAdapter.connect(loSigner).sell(await wethVault.getAddress(), 0n)).to.be.revertedWithCustomError(
        vaultAdapter,
        "AmountMustBeGreaterThanZero",
      );
    });

    it("Approval hygiene: adapter holds no approvals after buy/sell", async function () {
      // Setup: buy a small amount
      const smallShares = ethers.parseUnits("0.1", WETH_DECIMALS);
      const previewCost = await vaultAdapter.previewBuy.staticCall(await wethVault.getAddress(), smallShares);
      const maxUSDC = (previewCost * 10200n) / 10000n;
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);
      await vaultAdapter.connect(loSigner).buy(await wethVault.getAddress(), smallShares);

      const adapterAddr = await vaultAdapter.getAddress();
      const uniswapAddr = await uniswapAdapter.getAddress();

      // No leftover USDC approval from adapter → uniswap
      expect(await usdc.allowance(adapterAddr, uniswapAddr)).to.equal(0n);
      // No leftover WETH approval from adapter → vault
      expect(await weth.allowance(adapterAddr, await wethVault.getAddress())).to.equal(0n);

      // Sell and check again
      const shares = await wethVault.balanceOf(loSigner.address);
      await wethVault.connect(loSigner).approve(adapterAddr, shares);
      await vaultAdapter.connect(loSigner).sell(await wethVault.getAddress(), shares);

      expect(await usdc.allowance(adapterAddr, uniswapAddr)).to.equal(0n);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7b. Partial sell via WETH adapter stack (cross-asset, 40% / 60% split)
  //
  // This is the more interesting variant of the partial-redeem test because each
  // sell hop goes: vault.redeem → WETH → Uniswap → USDC, exercising rounding
  // across two protocols rather than one.
  // ─────────────────────────────────────────────────────────────────────────

  describe("Partial sell via WETH adapter stack (cross-asset 40% / 60%)", function () {
    const BUY_SHARES = ethers.parseUnits("1", WETH_DECIMALS); // 1.0 omWETH
    let initialUSDC: bigint;
    /** Pre-buy quote for BUY_SHARES — used as the round-trip benchmark so the
     *  minReceivable check reflects actual entry cost, not post-trade prices. */
    let entryCost: bigint;
    /** Vault's Morpho position BEFORE our buy — used as exit baseline. */
    let morphoSharesAtEntry: bigint;
    /** Vault's Morpho position AFTER our buy — used as 40%-sell upper bound. */
    let morphoSharesAfterBuy: bigint;

    before(async function () {
      this.timeout(60_000);
      // Snapshot Morpho position BEFORE the buy: after a full two-step exit, the
      // vault's position should return to this baseline (+ dust from our own rounding).
      // Recording it here (not after) is necessary because the vault accumulates Morpho
      // shares from all earlier test blocks.
      const posBefore = await morpho.position(MAINNET.WETH_WSTETH_945_MARKET_ID, await wethVault.getAddress());
      morphoSharesAtEntry = posBefore.supplyShares;

      // Capture entry cost BEFORE the buy so the round-trip benchmark is not
      // skewed by post-trade pool/vault price changes.
      entryCost = await vaultAdapter.previewBuy.staticCall(await wethVault.getAddress(), BUY_SHARES);
      const maxUSDC = (entryCost * (10000n + SLIPPAGE)) / 10000n;
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);
      await vaultAdapter.connect(loSigner).buy(await wethVault.getAddress(), BUY_SHARES);

      const posAfterBuy = await morpho.position(MAINNET.WETH_WSTETH_945_MARKET_ID, await wethVault.getAddress());
      morphoSharesAfterBuy = posAfterBuy.supplyShares;

      initialUSDC = await usdc.balanceOf(loSigner.address);
    });

    it("Sell 40% omWETH: correct USDC received and Morpho position reduced proportionally", async function () {
      this.timeout(60_000);
      const totalShares = await wethVault.balanceOf(loSigner.address);
      const fortyPct = (totalShares * 40n) / 100n;

      const previewCost = await vaultAdapter.previewBuy.staticCall(await wethVault.getAddress(), fortyPct);
      // Expect USDC back ≈ 40% of what a full exit would yield (within Uniswap slippage)
      const usdcBefore = await usdc.balanceOf(loSigner.address);
      await wethVault.connect(loSigner).approve(await vaultAdapter.getAddress(), fortyPct);
      await vaultAdapter.connect(loSigner).sell(await wethVault.getAddress(), fortyPct);
      const usdcAfter = await usdc.balanceOf(loSigner.address);

      const receivedUsdc = usdcAfter - usdcBefore;
      expect(receivedUsdc).to.be.gt(0n);

      // Remaining shares == 60% of original
      const remainingShares = await wethVault.balanceOf(loSigner.address);
      expect(remainingShares).to.equal(totalShares - fortyPct);

      // Morpho position reduced compared to post-buy peak but still non-zero
      const posAfter40 = await morpho.position(MAINNET.WETH_WSTETH_945_MARKET_ID, await wethVault.getAddress());
      expect(posAfter40.supplyShares).to.be.lt(morphoSharesAfterBuy);
      expect(posAfter40.supplyShares).to.be.gt(0n);

      // No WETH or USDC dust left in vault or adapter
      expect(await weth.balanceOf(await wethVault.getAddress())).to.equal(0n);
      expect(await weth.balanceOf(await vaultAdapter.getAddress())).to.be.lt(MAX_TOKEN_DUST);
      expect(await usdc.balanceOf(await vaultAdapter.getAddress())).to.be.lt(MAX_TOKEN_DUST);

      console.log(`  40% sell → ${ethers.formatUnits(receivedUsdc, USDC_DECIMALS)} USDC`);
      console.log(`  Remaining shares: ${ethers.formatUnits(remainingShares, WETH_DECIMALS)} omWETH`);
      console.log(`  Morpho supplyShares after 40%: ${posAfter40.supplyShares}`);
      void previewCost; // referenced for documentation
    });

    it("Sell remaining 60% omWETH: full exit, dust within threshold", async function () {
      this.timeout(60_000);
      const remainingShares = await wethVault.balanceOf(loSigner.address);
      expect(remainingShares).to.be.gt(0n);

      await wethVault.connect(loSigner).approve(await vaultAdapter.getAddress(), remainingShares);
      const usdcBefore = await usdc.balanceOf(loSigner.address);
      await vaultAdapter.connect(loSigner).sell(await wethVault.getAddress(), remainingShares);
      const usdcAfter = await usdc.balanceOf(loSigner.address);

      expect(usdcAfter - usdcBefore).to.be.gt(0n);
      expect(await wethVault.balanceOf(loSigner.address)).to.equal(0n);

      // After selling all of loSigner's shares, the vault's Morpho position should return
      // to morphoSharesAtEntry (the baseline from other tests) plus at most rounding dust
      // contributed by our own two-step exit. We do NOT assert the absolute position is
      // near-zero because the vault holds accumulated positions from earlier test blocks.
      const posFinal = await morpho.position(MAINNET.WETH_WSTETH_945_MARKET_ID, await wethVault.getAddress());
      expect(posFinal.supplyShares, "post-exit Morpho position must be at or below pre-buy baseline + dust").to.be.lte(
        morphoSharesAtEntry + MORPHO_SHARES_DUST,
      );

      // No tokens stranded anywhere
      expect(await weth.balanceOf(await wethVault.getAddress())).to.equal(0n);
      expect(await weth.balanceOf(await vaultAdapter.getAddress())).to.be.lt(MAX_TOKEN_DUST);
      expect(await usdc.balanceOf(await vaultAdapter.getAddress())).to.be.lt(MAX_TOKEN_DUST);

      // Total USDC recovered across both sells should be within swap slippage of original cost.
      // Use entryCost (captured before the buy in `before`) so the benchmark reflects actual
      // entry price rather than the post-trade pool state.
      const totalReceived = usdcAfter - initialUSDC;
      const minReceivable = (entryCost * (10000n - SLIPPAGE * 2n)) / 10000n;
      expect(totalReceived, "total round-trip USDC recovery").to.be.gte(minReceivable);

      console.log(`  60% sell → ${ethers.formatUnits(usdcAfter - usdcBefore, USDC_DECIMALS)} USDC`);
      console.log(`  Morpho supplyShares dust: ${posFinal.supplyShares}`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. Multiple sequential operations & share accounting precision
  // ─────────────────────────────────────────────────────────────────────────

  describe("Share accounting precision", function () {
    it("Multiple sequential buys accumulate shares without drift", async function () {
      this.timeout(120_000);
      const sharesPerBuy = ethers.parseUnits("0.2", WETH_DECIMALS);
      let expectedShares = 0n;

      for (let i = 0; i < 3; i++) {
        const cost = await vaultAdapter.previewBuy.staticCall(await wethVault.getAddress(), sharesPerBuy);
        const maxUSDC = (cost * 10200n) / 10000n;
        await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);
        await vaultAdapter.connect(loSigner).buy(await wethVault.getAddress(), sharesPerBuy);
        expectedShares += sharesPerBuy;

        const actual = await wethVault.balanceOf(loSigner.address);
        expect(actual).to.equal(expectedShares);
        console.log(`  Iteration ${i + 1}: ${ethers.formatUnits(actual, WETH_DECIMALS)} omWETH`);
      }
    });

    it("Vault's Morpho position grows correctly after multiple deposits", async function () {
      const pos = await morpho.position(MAINNET.WETH_WSTETH_945_MARKET_ID, await wethVault.getAddress());
      // position ID matches the vault's MARKET_ID
      expect(pos.supplyShares).to.be.gt(0n);
      console.log(`  Vault Morpho supplyShares: ${pos.supplyShares}`);
      console.log(`  Vault totalAssets(): ${ethers.formatUnits(await wethVault.totalAssets(), WETH_DECIMALS)} WETH`);
    });

    it("totalAssets() grows after time passes (MorphoBalancesLib projects accrued interest)", async function () {
      this.timeout(30_000);
      // Snapshot totalAssets before advancing time
      const assetsBefore = await wethVault.totalAssets();
      expect(assetsBefore).to.be.gt(0n);

      // Advance EVM clock by 30 days — Morpho's AdaptiveCurve IRM accrues interest
      // continuously, so expectedSupplyAssets will project a higher number
      await provider.send("evm_increaseTime", [30 * 24 * 3600]);
      await provider.send("evm_mine", []);

      const assetsAfter = await wethVault.totalAssets();

      // Hard check: interest was earned — totalAssets must be strictly greater.
      expect(assetsAfter).to.be.gt(assetsBefore);

      // Soft diagnostic: log the delta and estimated APY.
      // We intentionally do not hard-assert a minimum delta: utilisation on this market
      // could in theory be very low, making the 30-day accrual smaller than any fixed floor.
      // The strict gt() above is sufficient to prove accrual is non-zero.
      const delta = assetsAfter - assetsBefore;
      const apyBps = (delta * 12n * 10000n) / assetsBefore; // rough annual projection
      console.log(`  Interest earned over 30d: ${ethers.formatUnits(delta, WETH_DECIMALS)} WETH`);
      console.log(`  WETH vault annualised APY ≈ ${Number(apyBps) / 100} bps (estimated)`);

      // Hard upper-bound: APY < 200% → 30-day delta < 16% of principal.
      const maxDelta = (assetsBefore * 16n) / 100n;
      expect(delta, "interest delta must be below 200% APY equivalent").to.be.lt(maxDelta);
      console.log(`  totalAssets before: ${ethers.formatUnits(assetsBefore, WETH_DECIMALS)} WETH`);
      console.log(`  totalAssets after 30d: ${ethers.formatUnits(assetsAfter, WETH_DECIMALS)} WETH`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 9. Global invariants — snapshot-isolated
  //
  // Each test here takes an EVM snapshot in beforeEach and reverts in afterEach.
  // This means every test starts from whatever state the suite has accumulated
  // up to this point, but modifications are never visible to the next test.
  // That lets us assert strong global properties (totalSupply, totalAssets) without
  // worrying about cross-test contamination.
  // ─────────────────────────────────────────────────────────────────────────

  describe("Global invariants — snapshot-isolated (USDC vault)", function () {
    let snapId: string;

    beforeEach(async function () {
      snapId = await provider.send("evm_snapshot", []);
    });

    afterEach(async function () {
      await provider.send("evm_revert", [snapId]);
    });

    it("deposit increments totalSupply by exactly shares and totalAssets by assets (within 1 share)", async function () {
      this.timeout(30_000);
      const depositAmount = ethers.parseUnits("500", USDC_DECIMALS);
      const [depositor] = await ethers.getSigners();
      await fundUsdc(depositor.address, depositAmount, owner);

      const supplyBefore = await usdcVault.totalSupply();
      const assetsBefore = await usdcVault.totalAssets();

      await usdc.connect(depositor).approve(await usdcVault.getAddress(), depositAmount);
      const shares = await usdcVault.connect(depositor).deposit.staticCall(depositAmount, depositor.address);
      await usdcVault.connect(depositor).deposit(depositAmount, depositor.address);

      expect(await usdcVault.totalSupply()).to.equal(supplyBefore + shares);
      // totalAssets increases by at least depositAmount and at most depositAmount + 1 share of rounding
      const assetsAfter = await usdcVault.totalAssets();
      expect(assetsAfter - assetsBefore).to.be.gte(depositAmount - 1n);
      expect(assetsAfter - assetsBefore).to.be.lte(depositAmount + 2n);

      console.log(`  totalSupply delta: ${shares} shares`);
      console.log(`  totalAssets delta: ${assetsAfter - assetsBefore} (expected ${depositAmount})`);
    });

    it("full redeem decrements totalSupply to baseline and totalAssets to near-baseline", async function () {
      this.timeout(30_000);
      const depositAmount = ethers.parseUnits("500", USDC_DECIMALS);
      const [depositor] = await ethers.getSigners();
      await fundUsdc(depositor.address, depositAmount, owner);

      const supplyBefore = await usdcVault.totalSupply();
      const assetsBefore = await usdcVault.totalAssets();

      await usdc.connect(depositor).approve(await usdcVault.getAddress(), depositAmount);
      await usdcVault.connect(depositor).deposit(depositAmount, depositor.address);

      const sharesToRedeem = await usdcVault.balanceOf(depositor.address);
      await usdcVault.connect(depositor).redeem(sharesToRedeem, depositor.address, depositor.address);

      // Supply is back to exactly the baseline (no leftover shares)
      expect(await usdcVault.totalSupply()).to.equal(supplyBefore);

      // Assets may differ by at most 1 USDC due to Morpho rounding dust
      const assetsAfterExit = await usdcVault.totalAssets();
      expect(assetsAfterExit).to.be.gte(assetsBefore);
      expect(assetsAfterExit - assetsBefore).to.be.lte(ethers.parseUnits("1", USDC_DECIMALS));
    });

    it("totalAssets() == convertToAssets(totalSupply()) within 1-share rounding", async function () {
      this.timeout(30_000);
      // The invariant only holds cleanly when totalSupply > 0.  When all shares have been
      // redeemed, Morpho rounding dust makes totalAssets() > 0 while convertToAssets(0) == 0.
      // Seed the vault with a small deposit so totalSupply is non-trivial before we measure.
      const seed = ethers.parseUnits("100", USDC_DECIMALS);
      const [depositor] = await ethers.getSigners();
      await fundUsdc(depositor.address, seed, owner);
      await usdc.connect(depositor).approve(await usdcVault.getAddress(), seed);
      await usdcVault.connect(depositor).deposit(seed, depositor.address);

      // ERC-4626 invariant: convertToAssets(totalSupply) should equal totalAssets
      // (or be within 1 unit due to OZ floor-rounding on the virtual shares denominator).
      const totalSupply = await usdcVault.totalSupply();
      const totalAssets = await usdcVault.totalAssets();
      const converted = await usdcVault.convertToAssets(totalSupply);

      // OZ ERC4626 uses floor(T * (A+1) / (T+1)) which introduces a systematic downward
      // bias of roughly (A - T) when accumulated Morpho dust makes totalAssets > totalSupply.
      // In practice this can be up to ~10 µUSDC on this market. Allow 20 µUSDC (0.00002 USDC).
      const tolerance = 20n;
      expect(converted, "converted >= totalAssets - tolerance").to.be.gte(
        totalAssets > tolerance ? totalAssets - tolerance : 0n,
      );
      expect(converted, "converted <= totalAssets + tolerance").to.be.lte(totalAssets + tolerance);

      console.log(`  totalAssets():               ${ethers.formatUnits(totalAssets, USDC_DECIMALS)} USDC`);
      console.log(`  convertToAssets(totalSupply): ${ethers.formatUnits(converted, USDC_DECIMALS)} USDC`);
    });

    it("share price is monotonically non-decreasing after 30-day time advance", async function () {
      this.timeout(30_000);
      const depositAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      const [depositor] = await ethers.getSigners();
      await fundUsdc(depositor.address, depositAmount, owner);
      await usdc.connect(depositor).approve(await usdcVault.getAddress(), depositAmount);
      await usdcVault.connect(depositor).deposit(depositAmount, depositor.address);

      const ts = await usdcVault.totalSupply();
      const priceBeforeBps = ((await usdcVault.totalAssets()) * 10000n) / ts;

      await provider.send("evm_increaseTime", [30 * 24 * 3600]);
      await provider.send("evm_mine", []);

      const priceAfterBps = ((await usdcVault.totalAssets()) * 10000n) / ts;

      expect(priceAfterBps).to.be.gte(priceBeforeBps);
      console.log(`  Share price (bps): ${priceBeforeBps} → ${priceAfterBps}`);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 11. Extended coverage — constructor, ACL, ERC-4626 edges (USDC vault)
  // ─────────────────────────────────────────────────────────────────────────

  describe("Extended coverage — constructor & adapter ACL", function () {
    it("Should reject deployment when Morpho market does not exist (lastUpdate == 0)", async function () {
      const VaultFactory = await ethers.getContractFactory("MorphoBlueSupplyVault");
      const fakeOracle = ethers.Wallet.createRandom().address;
      const fakeIrm = ethers.Wallet.createRandom().address;
      const fakeParams: MarketParams = {
        ...usdcMarketParams,
        oracle: fakeOracle,
        irm: fakeIrm,
      };
      await expect(VaultFactory.deploy(MAINNET.MORPHO_BLUE, fakeParams, "bad", "bad")).to.be.revertedWithCustomError(
        VaultFactory,
        "InvalidArguments",
      );
    });

    it("ERC4626ExecutionAdapter buy/sell reject callers that are not the liquidity orchestrator", async function () {
      const shares = ethers.parseUnits("1", USDC_DECIMALS);
      await fundUsdc(owner.address, ethers.parseUnits("5000", USDC_DECIMALS), owner);
      await usdc.connect(owner).approve(await vaultAdapter.getAddress(), ethers.parseUnits("5000", USDC_DECIMALS));
      await expect(vaultAdapter.connect(owner).buy(await usdcVault.getAddress(), shares)).to.be.revertedWithCustomError(
        vaultAdapter,
        "NotAuthorized",
      );
      await expect(vaultAdapter.connect(owner).sell(await usdcVault.getAddress(), 1n)).to.be.revertedWithCustomError(
        vaultAdapter,
        "NotAuthorized",
      );
    });
  });

  describe("Extended coverage — ERC-4626 alternate flows (USDC vault)", function () {
    let alice: SignerWithAddress;
    let bob: SignerWithAddress;

    before(async function () {
      const signers = await ethers.getSigners();
      alice = signers[14];
      bob = signers[15];
    });

    it("deposit pulls from caller and mints shares to a different receiver", async function () {
      this.timeout(30_000);
      const amount = ethers.parseUnits("250", USDC_DECIMALS);
      await fundUsdc(alice.address, amount * 2n, owner);
      await usdc.connect(alice).approve(await usdcVault.getAddress(), amount);

      const preview = await usdcVault.previewDeposit(amount);
      await usdcVault.connect(alice).deposit(amount, bob.address);

      expect(await usdcVault.balanceOf(bob.address)).to.equal(preview);
      expect(await usdcVault.balanceOf(alice.address)).to.equal(0n);
      expect(await usdc.balanceOf(await usdcVault.getAddress())).to.equal(0n);

      await usdcVault.connect(bob).redeem(preview, bob.address, bob.address);
    });

    it("redeem with allowance: approved spender can redeem on behalf of owner", async function () {
      this.timeout(30_000);
      const amount = ethers.parseUnits("180", USDC_DECIMALS);
      await fundUsdc(alice.address, amount * 2n, owner);
      await usdc.connect(alice).approve(await usdcVault.getAddress(), amount);
      await usdcVault.connect(alice).deposit(amount, alice.address);

      const shares = await usdcVault.balanceOf(alice.address);
      const usdcBefore = await usdc.balanceOf(alice.address);

      await usdcVault.connect(alice).approve(bob.address, shares);
      await usdcVault.connect(bob).redeem(shares, alice.address, alice.address);

      expect(await usdc.balanceOf(alice.address)).to.be.gt(usdcBefore);
      expect(await usdcVault.balanceOf(alice.address)).to.equal(0n);
    });

    it("mint() mints exact shares; assets pulled match previewMint", async function () {
      this.timeout(30_000);
      const targetShares = ethers.parseUnits("75", USDC_DECIMALS);
      const previewAssets = await usdcVault.previewMint(targetShares);
      await fundUsdc(alice.address, previewAssets * 2n, owner);
      await usdc.connect(alice).approve(await usdcVault.getAddress(), previewAssets * 2n);

      const spent = await usdcVault.connect(alice).mint.staticCall(targetShares, alice.address);
      await usdcVault.connect(alice).mint(targetShares, alice.address);

      expect(await usdcVault.balanceOf(alice.address)).to.equal(targetShares);
      expect(spent).to.be.closeTo(previewAssets, previewAssets / 200n);
      expect(await usdc.balanceOf(await usdcVault.getAddress())).to.equal(0n);

      await usdcVault.connect(alice).redeem(targetShares, alice.address, alice.address);
    });

    it("withdraw() exact assets matches previewWithdraw and burns expected shares", async function () {
      this.timeout(30_000);
      const depositAmt = ethers.parseUnits("400", USDC_DECIMALS);
      await fundUsdc(alice.address, depositAmt * 2n, owner);
      await usdc.connect(alice).approve(await usdcVault.getAddress(), depositAmt);
      await usdcVault.connect(alice).deposit(depositAmt, alice.address);

      const halfAssets = depositAmt / 2n;
      const previewShares = await usdcVault.previewWithdraw(halfAssets);
      const burned = await usdcVault.connect(alice).withdraw.staticCall(halfAssets, alice.address, alice.address);
      await usdcVault.connect(alice).withdraw(halfAssets, alice.address, alice.address);

      expect(burned).to.be.closeTo(previewShares, previewShares / 100n);
      expect(await usdcVault.balanceOf(alice.address)).to.be.gt(0n);

      const rest = await usdcVault.balanceOf(alice.address);
      await usdcVault.connect(alice).redeem(rest, alice.address, alice.address);
    });

    it("previewDeposit matches deposit.staticCall on fresh vaults (no stale Morpho dust)", async function () {
      this.timeout(120_000);
      const VaultFactory = await ethers.getContractFactory("MorphoBlueSupplyVault");
      const amounts = [
        ethers.parseUnits("11", USDC_DECIMALS),
        ethers.parseUnits("111", USDC_DECIMALS),
        ethers.parseUnits("1111", USDC_DECIMALS),
      ];
      for (const amt of amounts) {
        const isolated = (await VaultFactory.deploy(
          MAINNET.MORPHO_BLUE,
          usdcMarketParams,
          "isoUSDC",
          "iso",
        )) as unknown as MorphoBlueSupplyVault;
        await isolated.waitForDeployment();
        await fundUsdc(alice.address, amt * 2n, owner);
        await usdc.connect(alice).approve(await isolated.getAddress(), amt);
        const prev = await isolated.previewDeposit(amt);
        const viaStatic = await isolated.connect(alice).deposit.staticCall(amt, alice.address);
        expect(prev).to.equal(viaStatic);
        await isolated.connect(alice).deposit(amt, alice.address);
        const sh = await isolated.balanceOf(alice.address);
        await isolated.connect(alice).redeem(sh, alice.address, alice.address);
      }
    });

    it("reverts: deposit without token approval", async function () {
      const amount = ethers.parseUnits("50", USDC_DECIMALS);
      await fundUsdc(alice.address, amount * 2n, owner);
      await expect(usdcVault.connect(alice).deposit(amount, alice.address)).to.be.rejected;
    });

    it("reverts: redeem more shares than balance", async function () {
      const amount = ethers.parseUnits("20", USDC_DECIMALS);
      await fundUsdc(alice.address, amount * 2n, owner);
      await usdc.connect(alice).approve(await usdcVault.getAddress(), amount);
      await usdcVault.connect(alice).deposit(amount, alice.address);

      const bal = await usdcVault.balanceOf(alice.address);
      await expect(
        usdcVault.connect(alice).redeem(bal + 1n, alice.address, alice.address),
      ).to.be.revertedWithCustomError(usdcVault, "ERC4626ExceededMaxRedeem");
    });

    it("cumulative deposits from one user preserve share/asset relationship (isolated vault)", async function () {
      this.timeout(90_000);
      const VaultFactory = await ethers.getContractFactory("MorphoBlueSupplyVault");
      const v = (await VaultFactory.deploy(
        MAINNET.MORPHO_BLUE,
        usdcMarketParams,
        "cumUSDC",
        "cum",
      )) as unknown as MorphoBlueSupplyVault;
      await v.waitForDeployment();

      const chunks = [
        ethers.parseUnits("50", USDC_DECIMALS),
        ethers.parseUnits("120", USDC_DECIMALS),
        ethers.parseUnits("333", USDC_DECIMALS),
      ];
      let totalAssetsIn = 0n;
      for (const c of chunks) {
        totalAssetsIn += c;
        await fundUsdc(alice.address, c * 2n, owner);
        await usdc.connect(alice).approve(await v.getAddress(), c);
        await v.connect(alice).deposit(c, alice.address);
      }
      const shares = await v.balanceOf(alice.address);
      const back = await v.convertToAssets(shares);
      expect(back).to.be.closeTo(totalAssetsIn, totalAssetsIn / 100n);

      await v.connect(alice).redeem(shares, alice.address, alice.address);
    });
  });

  describe("Extended coverage — WETH vault mint/withdraw smoke", function () {
    let carol: SignerWithAddress;

    before(async function () {
      carol = (await ethers.getSigners())[16];
    });

    it("mint and withdraw round-trip on WETH vault", async function () {
      this.timeout(60_000);
      const targetShares = ethers.parseUnits("0.03", WETH_DECIMALS);
      const previewAssets = await wethVault.previewMint(targetShares);
      await fundWeth(carol.address, previewAssets * 3n, owner);
      await weth.connect(carol).approve(await wethVault.getAddress(), previewAssets * 3n);

      await wethVault.connect(carol).mint(targetShares, carol.address);
      expect(await wethVault.balanceOf(carol.address)).to.equal(targetShares);

      const assetsOut = previewAssets / 3n;
      const prevSh = await wethVault.previewWithdraw(assetsOut);
      await wethVault.connect(carol).withdraw(assetsOut, carol.address, carol.address);
      const afterPartial = await wethVault.balanceOf(carol.address);
      expect(afterPartial).to.be.closeTo(targetShares - prevSh, ethers.parseUnits("0.0000005", WETH_DECIMALS));

      await wethVault.connect(carol).redeem(afterPartial, carol.address, carol.address);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 12. Token balance invariants (comprehensive sweep)
  // ─────────────────────────────────────────────────────────────────────────

  describe("Token balance invariants", function () {
    it("omUSDC vault never holds USDC at rest", async function () {
      expect(await usdc.balanceOf(await usdcVault.getAddress())).to.equal(0n);
    });

    it("omWETH vault never holds WETH at rest", async function () {
      expect(await weth.balanceOf(await wethVault.getAddress())).to.equal(0n);
    });

    it("ERC4626ExecutionAdapter holds no tokens at rest", async function () {
      const adapterAddr = await vaultAdapter.getAddress();
      expect(await usdc.balanceOf(adapterAddr)).to.be.lt(MAX_TOKEN_DUST);
      expect(await weth.balanceOf(adapterAddr)).to.be.lt(MAX_TOKEN_DUST);
      expect(await usdcVault.balanceOf(adapterAddr)).to.be.lt(MAX_TOKEN_DUST);
      expect(await wethVault.balanceOf(adapterAddr)).to.be.lt(MAX_TOKEN_DUST);
    });

    it("UniswapV3ExecutionAdapter holds no tokens at rest", async function () {
      const uniswapAddr = await uniswapAdapter.getAddress();
      expect(await usdc.balanceOf(uniswapAddr)).to.be.lt(MAX_TOKEN_DUST);
      expect(await weth.balanceOf(uniswapAddr)).to.be.lt(MAX_TOKEN_DUST);
    });
  });
});
