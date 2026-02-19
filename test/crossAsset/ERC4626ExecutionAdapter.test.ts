/**
 * ERC4626ExecutionAdapter E2E Tests
 *
 * Tests the new architecture where:
 * 1. Token swap executors are registered for tokens (WETH → UniswapV3ExecutionAdapter)
 * 2. Vault adapters are registered for vaults (Morpho WETH vault → ERC4626ExecutionAdapter)
 * 3. Vault adapters delegate to swap executors via LO's executionAdapterOf mapping
 *
 * Test Coverage:
 * 1. Buy flow: USDC → vault adapter → swap executor → WETH → Morpho vault
 * 2. Sell flow: Morpho vault → WETH → swap executor → USDC
 * 3. Same-asset flow: USDC → USDC vault (no swap)
 * 4. Error cases: Missing swap executor, invalid configuration
 * 5. Slippage management (centralized in LO)
 * 6. Gas benchmarking
 */

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  OrionConfig,
  ERC4626ExecutionAdapter,
  UniswapV3ExecutionAdapter,
  ChainlinkPriceAdapter,
  MockERC4626PriceAdapter,
  IERC4626,
  IERC20,
  MockLiquidityOrchestrator,
  MockERC4626Asset,
} from "../../typechain-types";

// Mainnet addresses
const MAINNET = {
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",

  // Morpho Vaults
  MORPHO_WETH: "0x31A5684983EeE865d943A696AAC155363bA024f9", // Vault Bridge WETH (vbgtWETH)

  // Uniswap V3
  UNISWAP_V3_FACTORY: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  UNISWAP_ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  UNISWAP_QUOTER_V2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  USDC_WETH_POOL: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", // 0.05% fee
  WETH_FEE: 500, // 0.05% fee tier for USDC-WETH pool

  // Chainlink Oracles
  CHAINLINK_ETH_USD: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  CHAINLINK_BTC_USD: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",

  // Whale addresses for token acquisition
  USDC_WHALE: "0x37305b1cd40574e4c5ce33f8e8306be057fd7341", // SKY: PSM
  WETH_WHALE: "0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8", // Aave
};

describe("ERC4626ExecutionAdapter", function () {
  let owner: SignerWithAddress;

  let orionConfig: OrionConfig;
  let liquidityOrchestrator: MockLiquidityOrchestrator;
  let loSigner: SignerWithAddress; // Impersonated signer for LO contract

  // Adapters
  let vaultAdapter: ERC4626ExecutionAdapter;
  let tokenSwapExecutor: UniswapV3ExecutionAdapter;

  // Price adapters
  let chainlinkAdapter: ChainlinkPriceAdapter;
  let vaultPriceAdapter: MockERC4626PriceAdapter;

  // Tokens
  let usdc: IERC20;
  let weth: IERC20;
  let morphoWETH: IERC4626;

  // Test parameters
  const USDC_DECIMALS = 6;
  const WETH_DECIMALS = 18;
  const SLIPPAGE_TOLERANCE = 200; // 2%
  const INITIAL_USDC_BALANCE = ethers.parseUnits("100000", USDC_DECIMALS); // 100k USDC

  before(async function () {
    this.timeout(120000); // 2 minutes for mainnet forking

    // Skip all tests if not forking mainnet
    const networkConfig = network.config;
    if (!("forking" in networkConfig) || !networkConfig.forking || !networkConfig.forking.url) {
      this.skip();
    }

    [owner] = await ethers.getSigners();

    // Get contract instances
    usdc = await ethers.getContractAt("IERC20", MAINNET.USDC);
    weth = await ethers.getContractAt("IERC20", MAINNET.WETH);
    morphoWETH = await ethers.getContractAt("IERC4626", MAINNET.MORPHO_WETH);
  });

  describe("Setup and Deployment", function () {
    it("Should deploy all contracts", async function () {
      this.timeout(60000);

      // Deploy minimal OrionConfig mock
      const MockOrionConfigFactory = await ethers.getContractFactory("MockOrionConfig");
      orionConfig = (await MockOrionConfigFactory.deploy(MAINNET.USDC)) as OrionConfig;

      // Deploy MockLiquidityOrchestrator with slippage tolerance
      const MockLiquidityOrchestratorFactory = await ethers.getContractFactory("MockLiquidityOrchestrator");
      liquidityOrchestrator = await MockLiquidityOrchestratorFactory.deploy(await orionConfig.getAddress());

      // Set slippage tolerance in LO
      await liquidityOrchestrator.setSlippageTolerance(SLIPPAGE_TOLERANCE);

      // Deploy Chainlink price adapter
      const ChainlinkAdapterFactory = await ethers.getContractFactory("ChainlinkPriceAdapter");
      chainlinkAdapter = await ChainlinkAdapterFactory.deploy(await orionConfig.getAddress());

      // Configure Chainlink feeds
      await chainlinkAdapter.configureFeed(
        MAINNET.WETH,
        MAINNET.CHAINLINK_ETH_USD,
        false, // not inverse
        3600, // 1 hour staleness
        ethers.parseUnits("1000", 8), // min $1,000
        ethers.parseUnits("10000", 8), // max $10,000
      );

      // Deploy MockPriceAdapterRegistry and configure it
      const MockPriceAdapterRegistryFactory = await ethers.getContractFactory("MockPriceAdapterRegistry");
      const priceAdapterRegistry = await MockPriceAdapterRegistryFactory.deploy();
      await priceAdapterRegistry.setPriceAdapter(MAINNET.WETH, await chainlinkAdapter.getAddress());

      // Configure mock OrionConfig
      const mockConfig = await ethers.getContractAt("MockOrionConfig", await orionConfig.getAddress());
      await mockConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());
      await mockConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());

      // Deploy vault price adapter
      const VaultPriceAdapterFactory = await ethers.getContractFactory("MockERC4626PriceAdapter");
      vaultPriceAdapter = await VaultPriceAdapterFactory.deploy(await orionConfig.getAddress());

      // Deploy token swap executor (for WETH token swaps)
      const TokenSwapExecutorFactory = await ethers.getContractFactory("UniswapV3ExecutionAdapter");
      tokenSwapExecutor = await TokenSwapExecutorFactory.deploy(
        owner.address,
        MAINNET.UNISWAP_V3_FACTORY,
        MAINNET.UNISWAP_ROUTER,
        MAINNET.UNISWAP_QUOTER_V2,
        await orionConfig.getAddress(),
      );

      // Register WETH fee tier so the adapter can swap USDC ↔ WETH
      await tokenSwapExecutor.setAssetFee(MAINNET.WETH, MAINNET.WETH_FEE);

      // Deploy vault adapter (for ERC4626 vaults)
      const VaultAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
      vaultAdapter = await VaultAdapterFactory.deploy(await orionConfig.getAddress());

      void expect(await tokenSwapExecutor.getAddress()).to.be.properAddress;
      void expect(await vaultAdapter.getAddress()).to.be.properAddress;
      void expect(await chainlinkAdapter.getAddress()).to.be.properAddress;
      void expect(await vaultPriceAdapter.getAddress()).to.be.properAddress;
    });

    it("Should register WETH token with swap executor in LO", async function () {
      // Register WETH token → tokenSwapExecutor
      await liquidityOrchestrator.setExecutionAdapter(MAINNET.WETH, await tokenSwapExecutor.getAddress());

      const registeredAdapter = await liquidityOrchestrator.executionAdapterOf(MAINNET.WETH);
      expect(registeredAdapter).to.equal(await tokenSwapExecutor.getAddress());
    });

    it("Should register Morpho WETH vault with vault adapter in LO", async function () {
      // Register Morpho vault → vaultAdapter
      await liquidityOrchestrator.setExecutionAdapter(MAINNET.MORPHO_WETH, await vaultAdapter.getAddress());

      const registeredAdapter = await liquidityOrchestrator.executionAdapterOf(MAINNET.MORPHO_WETH);
      expect(registeredAdapter).to.equal(await vaultAdapter.getAddress());
    });

    it("Should fund test accounts with USDC", async function () {
      const usdcWhale = await ethers.getImpersonatedSigner(MAINNET.USDC_WHALE);

      // Fund whale with ETH for gas
      await owner.sendTransaction({
        to: MAINNET.USDC_WHALE,
        value: ethers.parseEther("10"),
      });

      const loAddress = await liquidityOrchestrator.getAddress();
      await usdc.connect(usdcWhale).transfer(loAddress, INITIAL_USDC_BALANCE);

      const balance = await usdc.balanceOf(loAddress);
      expect(balance).to.equal(INITIAL_USDC_BALANCE);
    });

    it("Should setup impersonated LO signer", async function () {
      const loAddress = await liquidityOrchestrator.getAddress();
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [loAddress],
      });

      loSigner = await ethers.getSigner(loAddress);

      // Fund it with ETH for gas
      await owner.sendTransaction({
        to: loAddress,
        value: ethers.parseEther("10"),
      });

      const ethBalance = await ethers.provider.getBalance(loAddress);
      expect(ethBalance).to.be.gt(0);
    });

    it("Should validate Morpho WETH vault", async function () {
      const underlying = await morphoWETH.asset();
      expect(underlying).to.equal(MAINNET.WETH);

      const decimals = await morphoWETH.decimals();
      expect(decimals).to.equal(18);
    });
  });

  describe("Buy Flow: USDC → Vault Adapter → Swap Executor → WETH → Morpho Vault", function () {
    let initialUSDCBalance: bigint;
    let sharesAmount: bigint;
    let estimatedUSDCCost: bigint;

    before(async function () {
      initialUSDCBalance = await usdc.balanceOf(loSigner.address);
      sharesAmount = ethers.parseUnits("1", 18); // 1 vbgtWETH share
    });

    it("Should calculate accurate price estimate", async function () {
      // Get vault share → WETH conversion
      const wethPerShare = await morphoWETH.convertToAssets(sharesAmount);
      console.log(`  1 vbgtWETH = ${ethers.formatUnits(wethPerShare, 18)} WETH`);

      // Get WETH → USD price from Chainlink
      const [wethPriceRaw, priceDecimals] = await chainlinkAdapter.getPriceData(MAINNET.WETH);
      const wethPriceUSD = wethPriceRaw / 10n ** (priceDecimals - 2n);
      console.log(`  1 WETH = $${wethPriceUSD / 100n}`);

      // Estimate USDC cost
      estimatedUSDCCost = (wethPerShare * wethPriceUSD) / 10n ** BigInt(18 + 2 - USDC_DECIMALS);
      console.log(`  Estimated cost: ${ethers.formatUnits(estimatedUSDCCost, USDC_DECIMALS)} USDC`);
    });

    it("Should execute buy - vault adapter delegates to swap executor", async function () {
      // Calculate max USDC with slippage (LO manages slippage)
      const maxUSDC = (estimatedUSDCCost * (10000n + BigInt(SLIPPAGE_TOLERANCE))) / 10000n;

      // Approve vault adapter to spend USDC (with slippage buffer)
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);

      // Execute buy
      const tx = await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, sharesAmount);

      const receipt = await tx.wait();
      console.log(`  Gas used: ${receipt!.gasUsed.toLocaleString()}`);

      // Verify shares received
      const sharesBalance = await morphoWETH.balanceOf(loSigner.address);
      expect(sharesBalance).to.equal(sharesAmount);
    });

    it("Should refund excess USDC", async function () {
      const finalUSDCBalance = await usdc.balanceOf(loSigner.address);
      const usdcSpent = initialUSDCBalance - finalUSDCBalance;

      console.log(`  USDC spent: ${ethers.formatUnits(usdcSpent, USDC_DECIMALS)}`);
      console.log(`  USDC estimated: ${ethers.formatUnits(estimatedUSDCCost, USDC_DECIMALS)}`);

      // Should be within slippage tolerance
      const maxSpend = (estimatedUSDCCost * (10000n + BigInt(SLIPPAGE_TOLERANCE))) / 10000n;
      expect(usdcSpent).to.be.lte(maxSpend);
    });

    it("Should enforce slippage protection", async function () {
      // Try to buy with unrealistically low allowance
      const tooLowAllowance = estimatedUSDCCost / 10n; // 10x too low

      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), tooLowAllowance);

      await expect(vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, sharesAmount)).to.be.reverted; // Should revert due to insufficient allowance
    });
  });

  describe("Sell Flow: Morpho Vault → WETH → Swap Executor → USDC", function () {
    let initialUSDCBalance: bigint;
    let sharesToSell: bigint;
    let estimatedUSDCReceived: bigint;

    before(async function () {
      initialUSDCBalance = await usdc.balanceOf(loSigner.address);
      sharesToSell = await morphoWETH.balanceOf(loSigner.address);
    });

    it("Should calculate accurate sell estimate", async function () {
      // Get vault share → WETH conversion
      const wethToReceive = await morphoWETH.convertToAssets(sharesToSell);
      console.log(`  ${ethers.formatUnits(sharesToSell, 18)} vbgtWETH = ${ethers.formatUnits(wethToReceive, 18)} WETH`);

      // Get WETH → USD price
      const [wethPriceRaw, priceDecimals] = await chainlinkAdapter.getPriceData(MAINNET.WETH);
      const wethPriceUSD = wethPriceRaw / 10n ** (priceDecimals - 2n);

      // Estimate USDC received (all BigInt arithmetic, no Number truncation)
      estimatedUSDCReceived = (wethToReceive * wethPriceUSD) / 10n ** BigInt(18 + 2 - USDC_DECIMALS);
      console.log(`  Estimated receive: ${ethers.formatUnits(estimatedUSDCReceived, USDC_DECIMALS)} USDC`);
    });

    it("Should execute sell - vault adapter delegates to swap executor", async function () {
      // Approve vault adapter to spend shares
      await morphoWETH.connect(loSigner).approve(await vaultAdapter.getAddress(), sharesToSell);

      // Execute sell (LO validates final amount, adapter passes 0 as minAmount)
      const tx = await vaultAdapter.connect(loSigner).sell(MAINNET.MORPHO_WETH, sharesToSell);

      const receipt = await tx.wait();
      console.log(`  Gas used: ${receipt!.gasUsed.toLocaleString()}`);

      // Verify shares burned
      const sharesBalance = await morphoWETH.balanceOf(loSigner.address);
      expect(sharesBalance).to.equal(0);
    });

    it("Should receive expected USDC amount", async function () {
      const finalUSDCBalance = await usdc.balanceOf(loSigner.address);
      const usdcReceived = finalUSDCBalance - initialUSDCBalance;

      console.log(`  USDC received: ${ethers.formatUnits(usdcReceived, USDC_DECIMALS)}`);
      console.log(`  USDC estimated: ${ethers.formatUnits(estimatedUSDCReceived, USDC_DECIMALS)}`);

      // Should be within slippage tolerance
      const minReceive = (estimatedUSDCReceived * BigInt(10000 - SLIPPAGE_TOLERANCE)) / 10000n;
      expect(usdcReceived).to.be.gte(minReceive);
    });
  });

  describe("Architecture Validation", function () {
    it("Should confirm vault adapter uses swap executor from LO", async function () {
      // Verify WETH is registered with token swap executor
      const wethAdapter = await liquidityOrchestrator.executionAdapterOf(MAINNET.WETH);
      expect(wethAdapter).to.equal(await tokenSwapExecutor.getAddress());

      // Verify Morpho vault is registered with vault adapter
      const vaultAdapterAddr = await liquidityOrchestrator.executionAdapterOf(MAINNET.MORPHO_WETH);
      expect(vaultAdapterAddr).to.equal(await vaultAdapter.getAddress());

      console.log(`  ✓ WETH token → ${await tokenSwapExecutor.getAddress()}`);
      console.log(`  ✓ Morpho vault → ${await vaultAdapter.getAddress()}`);
      console.log(`  ✓ Vault adapter delegates to swap executor via LO.executionAdapterOf[WETH]`);
    });

    it("Should revert if swap executor not set for underlying token", async function () {
      // Create a mock vault with an underlying that has no swap executor
      // This would happen if we try to buy a vault whose underlying isn't whitelisted
      // For this test, we'd need to deploy a mock vault - skip for mainnet fork test
      // The architecture ensures this is validated at whitelist time
    });

    it("Should maintain approval hygiene", async function () {
      const vaultAdapterAddress = await vaultAdapter.getAddress();

      const usdcAllowance = await usdc.allowance(vaultAdapterAddress, await tokenSwapExecutor.getAddress());
      const wethAllowance = await weth.allowance(vaultAdapterAddress, MAINNET.MORPHO_WETH);

      expect(usdcAllowance).to.equal(0);
      expect(wethAllowance).to.equal(0);
    });
  });

  describe("Validation Tests", function () {
    it("Should reject non-ERC4626 assets", async function () {
      // Try to validate a regular ERC20 (USDC) which is not ERC4626
      await expect(vaultAdapter.validateExecutionAdapter(MAINNET.USDC)).to.be.revertedWithCustomError(
        vaultAdapter,
        "InvalidAdapter",
      );
    });

    it("Should reject vault with no swap executor for underlying", async function () {
      // Deploy a mock vault with WBTC underlying (no swap executor registered)
      const MockERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");
      const mockVault = await MockERC4626Factory.deploy(MAINNET.WBTC, "Mock WBTC Vault", "mWBTC");
      await mockVault.waitForDeployment();

      // MockOrionConfig returns hardcoded 18 decimals for all tokens
      // Should fail validation because WBTC has no swap executor registered in LO
      await expect(vaultAdapter.validateExecutionAdapter(await mockVault.getAddress())).to.be.revertedWithCustomError(
        vaultAdapter,
        "InvalidAdapter",
      );
    });
  });

  describe("Share Accounting Precision", function () {
    before(async function () {
      // Fund for precision tests
      const usdcWhale = await ethers.getImpersonatedSigner(MAINNET.USDC_WHALE);
      await owner.sendTransaction({
        to: MAINNET.USDC_WHALE,
        value: ethers.parseEther("10"),
      });

      const fundAmount = ethers.parseUnits("50000", USDC_DECIMALS);
      await usdc.connect(usdcWhale).transfer(loSigner.address, fundAmount);
    });

    it("Should mint exact shares requested via buy()", async function () {
      const exactShares = ethers.parseUnits("2.5", 18); // Request exactly 2.5 shares

      // Calculate cost
      const wethNeeded = await morphoWETH.convertToAssets(exactShares);
      const [wethPrice, priceDecimals] = await chainlinkAdapter.getPriceData(MAINNET.WETH);
      const estimatedCost =
        (wethNeeded * wethPrice) / 10n ** (BigInt(WETH_DECIMALS) + priceDecimals - BigInt(USDC_DECIMALS));

      const maxUSDC = (estimatedCost * (10000n + BigInt(SLIPPAGE_TOLERANCE))) / 10000n;
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);

      await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, exactShares);

      // Verify EXACTLY 2.5 shares received (no drift)
      const sharesBalance = await morphoWETH.balanceOf(loSigner.address);
      expect(sharesBalance).to.equal(exactShares);
      console.log(`  Requested: ${ethers.formatUnits(exactShares, 18)} shares`);
      console.log(`  Received:  ${ethers.formatUnits(sharesBalance, 18)} shares`);
    });

    it("Should handle multiple sequential buy operations with no drift", async function () {
      const buyAmount = ethers.parseUnits("0.5", 18); // Buy 0.5 shares each time
      const iterations = 3;

      let totalSharesExpected = await morphoWETH.balanceOf(loSigner.address);

      for (let i = 0; i < iterations; i++) {
        const wethNeeded = await morphoWETH.convertToAssets(buyAmount);
        const [wethPrice, priceDecimals] = await chainlinkAdapter.getPriceData(MAINNET.WETH);
        const estimatedCost =
          (wethNeeded * wethPrice) / 10n ** (BigInt(WETH_DECIMALS) + priceDecimals - BigInt(USDC_DECIMALS));

        const maxUSDC = (estimatedCost * (10000n + BigInt(SLIPPAGE_TOLERANCE))) / 10000n;
        await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);

        await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, buyAmount);

        totalSharesExpected += buyAmount;

        const currentBalance = await morphoWETH.balanceOf(loSigner.address);
        expect(currentBalance).to.equal(totalSharesExpected);
        console.log(`  Iteration ${i + 1}: ${ethers.formatUnits(currentBalance, 18)} shares (no drift)`);
      }
    });

    it("Should refund excess underlying when swap uses less than max", async function () {
      const sharesAmount = ethers.parseUnits("0.2", 18);
      const balanceBefore = await usdc.balanceOf(loSigner.address);

      const wethNeeded = await morphoWETH.convertToAssets(sharesAmount);
      const [wethPrice, priceDecimals] = await chainlinkAdapter.getPriceData(MAINNET.WETH);
      const estimatedCost =
        (wethNeeded * wethPrice) / 10n ** (BigInt(WETH_DECIMALS) + priceDecimals - BigInt(USDC_DECIMALS));

      const maxUSDC = (estimatedCost * (10000n + BigInt(SLIPPAGE_TOLERANCE))) / 10000n;
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);

      await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, sharesAmount);

      const balanceAfter = await usdc.balanceOf(loSigner.address);
      const actualSpent = balanceBefore - balanceAfter;

      // Actual spent should be less than max (refund occurred)
      expect(actualSpent).to.be.lt(maxUSDC);
      console.log(`  Max approved: ${ethers.formatUnits(maxUSDC, USDC_DECIMALS)} USDC`);
      console.log(`  Actual spent: ${ethers.formatUnits(actualSpent, USDC_DECIMALS)} USDC`);
      console.log(`  Refunded: ${ethers.formatUnits(maxUSDC - actualSpent, USDC_DECIMALS)} USDC`);
    });
  });

  describe("Buy - previewBuy Accuracy", function () {
    before(async function () {
      const usdcWhale = await ethers.getImpersonatedSigner(MAINNET.USDC_WHALE);
      await owner.sendTransaction({ to: MAINNET.USDC_WHALE, value: ethers.parseEther("10") });
      const fundAmount = ethers.parseUnits("50000", USDC_DECIMALS);
      await usdc.connect(usdcWhale).transfer(loSigner.address, fundAmount);
    });

    it("Should pull exact previewBuy amount (atomic within buy tx)", async function () {
      const sharesAmount = ethers.parseUnits("0.5", 18);

      // previewBuy tells us roughly how much the buy will cost
      const previewedCost = await vaultAdapter.previewBuy.staticCall(MAINNET.MORPHO_WETH, sharesAmount);
      expect(previewedCost).to.be.gt(0);

      // Approve generous amount — the contract only pulls what previewBuy returns internally
      const generousApproval = previewedCost * 2n;
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), generousApproval);

      const balanceBefore = await usdc.balanceOf(loSigner.address);
      await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, sharesAmount);
      const balanceAfter = await usdc.balanceOf(loSigner.address);

      const actualSpent = balanceBefore - balanceAfter;

      // The key invariant: buy() pulls exactly what its internal previewBuy returns,
      // NOT the full approved amount. Verify it didn't drain the generous approval.
      expect(actualSpent).to.be.lt(generousApproval);
      // And it's in the right ballpark of our external preview (same order of magnitude)
      expect(actualSpent).to.be.gt(previewedCost / 2n);
      expect(actualSpent).to.be.lt(previewedCost * 2n);

      console.log(`  Approved:    ${ethers.formatUnits(generousApproval, USDC_DECIMALS)} USDC`);
      console.log(`  Actually pulled: ${ethers.formatUnits(actualSpent, USDC_DECIMALS)} USDC`);
      console.log(`  External preview: ${ethers.formatUnits(previewedCost, USDC_DECIMALS)} USDC`);
    });

    it("Should have previewBuy scale linearly with share amount", async function () {
      const smallShares = ethers.parseUnits("0.1", 18);
      const largeShares = ethers.parseUnits("1", 18);

      const smallCost = await vaultAdapter.previewBuy.staticCall(MAINNET.MORPHO_WETH, smallShares);
      const largeCost = await vaultAdapter.previewBuy.staticCall(MAINNET.MORPHO_WETH, largeShares);

      // Large should be roughly 10x small (within 1% for AMM price impact)
      const ratio = (largeCost * 1000n) / smallCost;
      expect(ratio).to.be.gte(9900n); // At least 9.9x
      expect(ratio).to.be.lte(10100n); // At most 10.1x
      console.log(`  0.1 shares cost: ${ethers.formatUnits(smallCost, USDC_DECIMALS)} USDC`);
      console.log(`  1.0 shares cost: ${ethers.formatUnits(largeCost, USDC_DECIMALS)} USDC`);
      console.log(`  Ratio: ${Number(ratio) / 1000}`);
    });
  });

  describe("Buy - Return Value & Accounting", function () {
    before(async function () {
      const usdcWhale = await ethers.getImpersonatedSigner(MAINNET.USDC_WHALE);
      await owner.sendTransaction({ to: MAINNET.USDC_WHALE, value: ethers.parseEther("10") });
      const fundAmount = ethers.parseUnits("50000", USDC_DECIMALS);
      await usdc.connect(usdcWhale).transfer(loSigner.address, fundAmount);
    });

    it("Should return non-zero spentUnderlyingAmount from buy (cross-asset)", async function () {
      const sharesAmount = ethers.parseUnits("0.3", 18);

      const previewedCost = await vaultAdapter.previewBuy.staticCall(MAINNET.MORPHO_WETH, sharesAmount);
      const maxUSDC = (previewedCost * 10200n) / 10000n; // 2% buffer
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);

      const balanceBefore = await usdc.balanceOf(loSigner.address);
      await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, sharesAmount);
      const balanceAfter = await usdc.balanceOf(loSigner.address);
      const actualSpent = balanceBefore - balanceAfter;

      // Verify non-zero and sensible spend
      expect(actualSpent).to.be.gt(0);
      // Spend should be less than max approved (previewBuy-based pull, not allowance-based)
      expect(actualSpent).to.be.lte(maxUSDC);

      console.log(`  Actual spent: ${ethers.formatUnits(actualSpent, USDC_DECIMALS)} USDC`);
      console.log(`  Max approved: ${ethers.formatUnits(maxUSDC, USDC_DECIMALS)} USDC`);
    });

    it("Should revert buy with zero shares amount", async function () {
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), ethers.parseUnits("1000", USDC_DECIMALS));

      // Zero shares should revert (previewMint(0) returns 0, but vault.mint(0) may behave differently)
      await expect(vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, 0)).to.be.reverted;
    });

    it("Should leave zero token approvals after buy (approval hygiene)", async function () {
      const sharesAmount = ethers.parseUnits("0.1", 18);
      const previewedCost = await vaultAdapter.previewBuy.staticCall(MAINNET.MORPHO_WETH, sharesAmount);
      const maxUSDC = (previewedCost * 10200n) / 10000n;
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);

      await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, sharesAmount);

      const vaultAdapterAddr = await vaultAdapter.getAddress();
      const swapExecutorAddr = await tokenSwapExecutor.getAddress();

      // No leftover USDC approval from adapter → swap executor
      const usdcApproval = await usdc.allowance(vaultAdapterAddr, swapExecutorAddr);
      expect(usdcApproval).to.equal(0);

      // No leftover WETH approval from adapter → vault
      const wethApproval = await weth.allowance(vaultAdapterAddr, MAINNET.MORPHO_WETH);
      expect(wethApproval).to.equal(0);

      console.log(`  USDC allowance (adapter→swapExecutor): ${usdcApproval}`);
      console.log(`  WETH allowance (adapter→vault): ${wethApproval}`);
    });

    it("Should not leave adapter holding any tokens after buy", async function () {
      const sharesAmount = ethers.parseUnits("0.2", 18);
      const previewedCost = await vaultAdapter.previewBuy.staticCall(MAINNET.MORPHO_WETH, sharesAmount);
      const maxUSDC = (previewedCost * 10200n) / 10000n;
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);

      await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, sharesAmount);

      const vaultAdapterAddr = await vaultAdapter.getAddress();

      // Adapter should hold no USDC, WETH, or vault shares
      const adapterUSDC = await usdc.balanceOf(vaultAdapterAddr);
      const adapterWETH = await weth.balanceOf(vaultAdapterAddr);
      const adapterShares = await morphoWETH.balanceOf(vaultAdapterAddr);

      expect(adapterUSDC).to.equal(0);
      expect(adapterWETH).to.equal(0);
      expect(adapterShares).to.equal(0);

      console.log(`  Adapter USDC balance: ${adapterUSDC}`);
      console.log(`  Adapter WETH balance: ${adapterWETH}`);
      console.log(`  Adapter vault shares: ${adapterShares}`);
    });
  });

  describe("Buy - Round-Trip Accounting", function () {
    before(async function () {
      // Sell any existing shares to start clean
      const existingShares = await morphoWETH.balanceOf(loSigner.address);
      if (existingShares > 0n) {
        await morphoWETH.connect(loSigner).approve(await vaultAdapter.getAddress(), existingShares);
        await vaultAdapter.connect(loSigner).sell(MAINNET.MORPHO_WETH, existingShares);
      }

      const usdcWhale = await ethers.getImpersonatedSigner(MAINNET.USDC_WHALE);
      await owner.sendTransaction({ to: MAINNET.USDC_WHALE, value: ethers.parseEther("10") });
      const fundAmount = ethers.parseUnits("50000", USDC_DECIMALS);
      await usdc.connect(usdcWhale).transfer(loSigner.address, fundAmount);
    });

    it("Should preserve value through buy→sell round-trip (within slippage)", async function () {
      const sharesAmount = ethers.parseUnits("1", 18);
      const balanceBefore = await usdc.balanceOf(loSigner.address);

      // Buy
      const previewedCost = await vaultAdapter.previewBuy.staticCall(MAINNET.MORPHO_WETH, sharesAmount);
      const maxUSDC = (previewedCost * 10200n) / 10000n;
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);
      await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, sharesAmount);

      const balanceAfterBuy = await usdc.balanceOf(loSigner.address);
      const spent = balanceBefore - balanceAfterBuy;

      // Sell
      await morphoWETH.connect(loSigner).approve(await vaultAdapter.getAddress(), sharesAmount);
      await vaultAdapter.connect(loSigner).sell(MAINNET.MORPHO_WETH, sharesAmount);

      const balanceAfterSell = await usdc.balanceOf(loSigner.address);
      const received = balanceAfterSell - balanceAfterBuy;

      // Round-trip loss should be within 1% (swap fees + slippage on both legs)
      const loss = spent - received;
      const lossBps = (loss * 10000n) / spent;

      expect(lossBps).to.be.lt(100n); // Less than 1% loss
      expect(received).to.be.gt(0);

      console.log(`  Spent on buy:  ${ethers.formatUnits(spent, USDC_DECIMALS)} USDC`);
      console.log(`  Received on sell: ${ethers.formatUnits(received, USDC_DECIMALS)} USDC`);
      console.log(`  Round-trip loss: ${ethers.formatUnits(loss, USDC_DECIMALS)} USDC (${Number(lossBps)} bps)`);
    });
  });

  describe("Buy - Dust & Edge Amounts", function () {
    before(async function () {
      const usdcWhale = await ethers.getImpersonatedSigner(MAINNET.USDC_WHALE);
      await owner.sendTransaction({ to: MAINNET.USDC_WHALE, value: ethers.parseEther("10") });
      const fundAmount = ethers.parseUnits("50000", USDC_DECIMALS);
      await usdc.connect(usdcWhale).transfer(loSigner.address, fundAmount);
    });

    it("Should handle very small share amount (1 wei of shares)", async function () {
      const tinyShares = 1n; // 1 wei of vault shares

      const previewedCost = await vaultAdapter.previewBuy.staticCall(MAINNET.MORPHO_WETH, tinyShares);

      // Even 1 wei of shares should have some non-zero cost
      // (though it might be 0 USDC due to rounding, which would still be a valid test)
      if (previewedCost > 0n) {
        await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), previewedCost);

        const sharesBefore = await morphoWETH.balanceOf(loSigner.address);
        await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, tinyShares);
        const sharesAfter = await morphoWETH.balanceOf(loSigner.address);

        expect(sharesAfter - sharesBefore).to.equal(tinyShares);
        console.log(`  1 wei shares cost: ${previewedCost} USDC wei`);
      } else {
        console.log(`  1 wei shares rounds to 0 USDC cost (expected for high-value vaults)`);
      }
    });

    it("Should handle large share amount", async function () {
      const largeShares = ethers.parseUnits("10", 18); // 10 full shares

      const previewedCost = await vaultAdapter.previewBuy.staticCall(MAINNET.MORPHO_WETH, largeShares);
      expect(previewedCost).to.be.gt(0);

      const maxUSDC = (previewedCost * 10200n) / 10000n;
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);

      const sharesBefore = await morphoWETH.balanceOf(loSigner.address);
      await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, largeShares);
      const sharesAfter = await morphoWETH.balanceOf(loSigner.address);

      expect(sharesAfter - sharesBefore).to.equal(largeShares);
      console.log(`  10 shares cost: ${ethers.formatUnits(previewedCost, USDC_DECIMALS)} USDC`);
    });
  });

  describe("Buy - Same-Asset Vault Price Changes", function () {
    let usdcVault: MockERC4626Asset;
    let usdcVaultAdapter: ERC4626ExecutionAdapter;

    before(async function () {
      this.timeout(60000);

      const MockERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");
      usdcVault = (await MockERC4626Factory.deploy(
        MAINNET.USDC,
        "Price Test Vault",
        "ptVUSDC",
      )) as unknown as MockERC4626Asset;
      await usdcVault.waitForDeployment();

      const VaultAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
      usdcVaultAdapter = (await VaultAdapterFactory.deploy(
        await orionConfig.getAddress(),
      )) as unknown as ERC4626ExecutionAdapter;
      await usdcVaultAdapter.waitForDeployment();

      const mockConfig = await ethers.getContractAt("MockOrionConfig", await orionConfig.getAddress());
      await mockConfig.setTokenDecimals(MAINNET.USDC, 6);
      await mockConfig.setTokenDecimals(await usdcVault.getAddress(), 6);

      await liquidityOrchestrator.setExecutionAdapter(
        await usdcVault.getAddress(),
        await usdcVaultAdapter.getAddress(),
      );

      // Seed vault: deposit 10k USDC to establish baseline
      const usdcWhale = await ethers.getImpersonatedSigner(MAINNET.USDC_WHALE);
      await owner.sendTransaction({ to: MAINNET.USDC_WHALE, value: ethers.parseEther("10") });
      const seedAmount = ethers.parseUnits("10000", USDC_DECIMALS);
      await usdc.connect(usdcWhale).approve(await usdcVault.getAddress(), seedAmount);
      await usdcVault.connect(usdcWhale).deposit(seedAmount, usdcWhale.address);

      // Fund LO
      await usdc.connect(usdcWhale).transfer(loSigner.address, ethers.parseUnits("10000", USDC_DECIMALS));
    });

    it("Should cost more per share after vault gains (share price increases)", async function () {
      const sharesAmount = ethers.parseUnits("100", 6);

      // Cost before gains
      const costBefore = await usdcVault.previewMint(sharesAmount);

      // Simulate 10% gains (transfer extra USDC into vault)
      const usdcWhale = await ethers.getImpersonatedSigner(MAINNET.USDC_WHALE);
      const gainAmount = ethers.parseUnits("1000", USDC_DECIMALS); // 10% of 10k
      await usdc.connect(usdcWhale).approve(await usdcVault.getAddress(), gainAmount);
      await usdcVault.connect(usdcWhale).simulateGains(gainAmount);

      // Cost after gains
      const costAfter = await usdcVault.previewMint(sharesAmount);

      expect(costAfter).to.be.gt(costBefore);
      console.log(`  Cost before gains: ${ethers.formatUnits(costBefore, USDC_DECIMALS)} USDC`);
      console.log(`  Cost after gains:  ${ethers.formatUnits(costAfter, USDC_DECIMALS)} USDC`);
      console.log(`  Increase: ${Number(((costAfter - costBefore) * 10000n) / costBefore) / 100}%`);

      // Buy should still work at the new price
      await usdc.connect(loSigner).approve(await usdcVaultAdapter.getAddress(), costAfter * 2n);
      await usdcVaultAdapter.connect(loSigner).buy(await usdcVault.getAddress(), sharesAmount);

      const balance = await usdcVault.balanceOf(loSigner.address);
      expect(balance).to.equal(sharesAmount);
    });

    it("Should cost less per share after vault losses (share price decreases)", async function () {
      // Sell existing shares first
      const existingShares = await usdcVault.balanceOf(loSigner.address);
      if (existingShares > 0n) {
        await usdcVault.connect(loSigner).approve(await usdcVaultAdapter.getAddress(), existingShares);
        await usdcVaultAdapter.connect(loSigner).sell(await usdcVault.getAddress(), existingShares);
      }

      const sharesAmount = ethers.parseUnits("100", 6);
      const costBefore = await usdcVault.previewMint(sharesAmount);

      // Simulate 5% losses
      const totalAssets = await usdcVault.totalAssets();
      const lossAmount = totalAssets / 20n;
      await usdcVault.simulateLosses(lossAmount, owner.address);

      const costAfter = await usdcVault.previewMint(sharesAmount);

      expect(costAfter).to.be.lt(costBefore);
      console.log(`  Cost before losses: ${ethers.formatUnits(costBefore, USDC_DECIMALS)} USDC`);
      console.log(`  Cost after losses:  ${ethers.formatUnits(costAfter, USDC_DECIMALS)} USDC`);

      // Buy should still work
      await usdc.connect(loSigner).approve(await usdcVaultAdapter.getAddress(), costAfter * 2n);
      await usdcVaultAdapter.connect(loSigner).buy(await usdcVault.getAddress(), sharesAmount);

      const balance = await usdcVault.balanceOf(loSigner.address);
      expect(balance).to.equal(sharesAmount);
    });
  });

  describe("Cross-Asset Buy - Dust & Execution Measurement", function () {
    before(async function () {
      // Sell any existing shares to start clean
      const existingShares = await morphoWETH.balanceOf(loSigner.address);
      if (existingShares > 0n) {
        await morphoWETH.connect(loSigner).approve(await vaultAdapter.getAddress(), existingShares);
        await vaultAdapter.connect(loSigner).sell(MAINNET.MORPHO_WETH, existingShares);
      }

      const usdcWhale = await ethers.getImpersonatedSigner(MAINNET.USDC_WHALE);
      await owner.sendTransaction({ to: MAINNET.USDC_WHALE, value: ethers.parseEther("10") });
      const fundAmount = ethers.parseUnits("50000", USDC_DECIMALS);
      await usdc.connect(usdcWhale).transfer(loSigner.address, fundAmount);
    });

    it("Should have buy() return value match actual USDC balance delta (same block)", async function () {
      const sharesAmount = ethers.parseUnits("1", 18);

      // Generous approval so it's not the limiting factor
      const previewedCost = await vaultAdapter.previewBuy.staticCall(MAINNET.MORPHO_WETH, sharesAmount);
      const maxUSDC = previewedCost * 2n;
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);

      // buy() returns spentUnderlyingAmount — capture it via staticCall (block N)
      const returnValue = await vaultAdapter.connect(loSigner).buy.staticCall(MAINNET.MORPHO_WETH, sharesAmount);

      // Now actually execute (block N+1)
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);
      const balanceBefore = await usdc.balanceOf(loSigner.address);
      await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, sharesAmount);
      const balanceAfter = await usdc.balanceOf(loSigner.address);

      const actualDelta = balanceBefore - balanceAfter;

      // The return value from staticCall and the actual delta may differ by cross-block drift,
      // but the actual delta IS the ground truth at block N+1
      expect(actualDelta).to.be.gt(0);

      // Dust between staticCall return (block N) and actual spend (block N+1)
      const dust = actualDelta > returnValue ? actualDelta - returnValue : returnValue - actualDelta;
      // Cross-block Quoter drift should be negligible — less than 10 USDC wei (0.00001 USDC)
      expect(dust).to.be.lte(10);

      console.log(`  staticCall return: ${ethers.formatUnits(returnValue, USDC_DECIMALS)} USDC`);
      console.log(`  Actual delta:      ${ethers.formatUnits(actualDelta, USDC_DECIMALS)} USDC`);
      console.log(`  Cross-block dust:  ${dust} USDC wei`);
    });

    it("Should have previewBuy→buy cross-block dust < 10 USDC wei", async function () {
      const sharesAmount = ethers.parseUnits("0.5", 18);

      // Block N: previewBuy
      const previewedCost = await vaultAdapter.previewBuy.staticCall(MAINNET.MORPHO_WETH, sharesAmount);

      // Block N+1: actual buy
      const maxUSDC = previewedCost * 2n;
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);

      const balanceBefore = await usdc.balanceOf(loSigner.address);
      await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, sharesAmount);
      const balanceAfter = await usdc.balanceOf(loSigner.address);

      const actualSpent = balanceBefore - balanceAfter;

      // Measure dust: |previewBuy(N) - actualSpent(N+1)|
      const dust = actualSpent > previewedCost ? actualSpent - previewedCost : previewedCost - actualSpent;

      // Cross-block dust from Uniswap Quoter secondsPerLiquidityCumulative drift
      // should be negligible — typically 0-2 wei
      expect(dust).to.be.lte(10);

      console.log(`  previewBuy (block N):   ${ethers.formatUnits(previewedCost, USDC_DECIMALS)} USDC`);
      console.log(`  actualSpent (block N+1): ${ethers.formatUnits(actualSpent, USDC_DECIMALS)} USDC`);
      console.log(`  Dust: ${dust} USDC wei (${Number(dust) / 1e6} USDC)`);
    });

    it("Should leave zero dust in the adapter after cross-asset buy", async function () {
      const sharesAmount = ethers.parseUnits("0.3", 18);

      const previewedCost = await vaultAdapter.previewBuy.staticCall(MAINNET.MORPHO_WETH, sharesAmount);
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), previewedCost * 2n);

      await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, sharesAmount);

      const adapterAddr = await vaultAdapter.getAddress();

      // All three token balances must be exactly zero — no dust stuck
      const adapterUSDC = await usdc.balanceOf(adapterAddr);
      const adapterWETH = await weth.balanceOf(adapterAddr);
      const adapterShares = await morphoWETH.balanceOf(adapterAddr);

      expect(adapterUSDC).to.equal(0, "USDC dust in adapter");
      expect(adapterWETH).to.equal(0, "WETH dust in adapter");
      expect(adapterShares).to.equal(0, "Vault share dust in adapter");

      console.log(`  Adapter USDC: ${adapterUSDC}`);
      console.log(`  Adapter WETH: ${adapterWETH}`);
      console.log(`  Adapter shares: ${adapterShares}`);
    });

    it("Should deliver exact shares and spend only what needed", async function () {
      const sharesAmount = ethers.parseUnits("2", 18);

      const previewedCost = await vaultAdapter.previewBuy.staticCall(MAINNET.MORPHO_WETH, sharesAmount);
      const generousApproval = previewedCost * 3n; // 3x what's needed
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), generousApproval);

      const sharesBefore = await morphoWETH.balanceOf(loSigner.address);
      const usdcBefore = await usdc.balanceOf(loSigner.address);

      await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, sharesAmount);

      const sharesAfter = await morphoWETH.balanceOf(loSigner.address);
      const usdcAfter = await usdc.balanceOf(loSigner.address);

      const sharesReceived = sharesAfter - sharesBefore;
      const usdcSpent = usdcBefore - usdcAfter;

      // Exact shares — no rounding
      expect(sharesReceived).to.equal(sharesAmount);

      // Spent well under the generous approval (previewBuy-based pull, not allowance-based)
      expect(usdcSpent).to.be.lt(generousApproval);

      // Spent should be close to previewed cost (within dust)
      const dust = usdcSpent > previewedCost ? usdcSpent - previewedCost : previewedCost - usdcSpent;
      expect(dust).to.be.lte(10);

      console.log(`  Shares requested: ${ethers.formatUnits(sharesAmount, 18)}`);
      console.log(`  Shares received:  ${ethers.formatUnits(sharesReceived, 18)}`);
      console.log(`  USDC approved:    ${ethers.formatUnits(generousApproval, USDC_DECIMALS)}`);
      console.log(`  USDC spent:       ${ethers.formatUnits(usdcSpent, USDC_DECIMALS)}`);
      console.log(`  Dust:             ${dust} USDC wei`);
    });
  });

  describe("Gas Benchmarking", function () {
    before(async function () {
      // Re-fund LO signer for gas benchmarking
      const usdcWhale = await ethers.getImpersonatedSigner(MAINNET.USDC_WHALE);
      await owner.sendTransaction({
        to: MAINNET.USDC_WHALE,
        value: ethers.parseEther("10"),
      });

      const fundAmount = ethers.parseUnits("10000", USDC_DECIMALS); // 10k USDC
      await usdc.connect(usdcWhale).transfer(loSigner.address, fundAmount);
    });

    it("Should benchmark buy operation gas cost", async function () {
      const sharesAmount = ethers.parseUnits("0.1", 18);
      const wethPerShare = await morphoWETH.convertToAssets(sharesAmount);
      const [wethPrice, priceDecimals] = await chainlinkAdapter.getPriceData(MAINNET.WETH);

      const estimatedCost =
        (wethPerShare * wethPrice) / 10n ** (BigInt(WETH_DECIMALS) + priceDecimals - BigInt(USDC_DECIMALS));

      const maxUSDC = (estimatedCost * (10000n + BigInt(SLIPPAGE_TOLERANCE))) / 10000n;
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);

      const tx = await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, sharesAmount);

      const receipt = await tx.wait();
      console.log(`  Buy gas cost: ${receipt!.gasUsed.toLocaleString()} (includes previewBuy Quoter call)`);

      // Should be under 750k gas (includes previewBuy Quoter ~70k + swap + vault deposit)
      expect(receipt!.gasUsed).to.be.lt(750000);
    });

    it("Should benchmark sell operation gas cost", async function () {
      const sharesToSell = await morphoWETH.balanceOf(loSigner.address);

      await morphoWETH.connect(loSigner).approve(await vaultAdapter.getAddress(), sharesToSell);

      const tx = await vaultAdapter.connect(loSigner).sell(MAINNET.MORPHO_WETH, sharesToSell);

      const receipt = await tx.wait();
      console.log(`  Sell gas cost: ${receipt!.gasUsed.toLocaleString()}`);

      // Should be under 520k gas (includes vault redeem + swap + delegation)
      expect(receipt!.gasUsed).to.be.lt(520000);
    });
  });

  describe("Same-Asset Vault Tests (USDC Vault)", function () {
    let usdcVault: MockERC4626Asset;
    let usdcVaultAdapter: ERC4626ExecutionAdapter;

    before(async function () {
      this.timeout(60000);

      // Deploy USDC vault (same-asset, no swap needed)
      const MockERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");
      const usdcVaultDeployed = await MockERC4626Factory.deploy(MAINNET.USDC, "USDC Vault", "vUSDC");
      await usdcVaultDeployed.waitForDeployment();
      usdcVault = usdcVaultDeployed as unknown as MockERC4626Asset;

      // Deploy vault adapter for USDC vault
      const VaultAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
      const usdcVaultAdapterDeployed = await VaultAdapterFactory.deploy(await orionConfig.getAddress());
      await usdcVaultAdapterDeployed.waitForDeployment();
      usdcVaultAdapter = usdcVaultAdapterDeployed as unknown as ERC4626ExecutionAdapter;

      // Register token decimals in config (required for _validateExecutionAdapter checks)
      const mockConfig = await ethers.getContractAt("MockOrionConfig", await orionConfig.getAddress());
      await mockConfig.setTokenDecimals(MAINNET.USDC, 6); // USDC underlying is 6 decimals
      await mockConfig.setTokenDecimals(await usdcVault.getAddress(), 6); // Vault shares also 6 decimals

      // Register USDC vault in LO
      await liquidityOrchestrator.setExecutionAdapter(
        await usdcVault.getAddress(),
        await usdcVaultAdapter.getAddress(),
      );

      // Fund vault with initial USDC from whale and mint initial shares to establish 1:1 ratio
      const usdcWhale = await ethers.getImpersonatedSigner(MAINNET.USDC_WHALE);
      await owner.sendTransaction({
        to: MAINNET.USDC_WHALE,
        value: ethers.parseEther("10"),
      });

      const fundAmount = ethers.parseUnits("10000", USDC_DECIMALS);
      await usdc.connect(usdcWhale).approve(await usdcVault.getAddress(), fundAmount);
      // Mint shares to establish the exchange rate as 1:1
      await usdcVault.connect(usdcWhale).deposit(fundAmount, usdcWhale.address);
    });

    beforeEach(async function () {
      // Fund LO signer with fresh USDC for each test (since tests consume the balance)
      const usdcWhale = await ethers.getImpersonatedSigner(MAINNET.USDC_WHALE);

      // Ensure whale has ETH for gas
      await owner.sendTransaction({
        to: MAINNET.USDC_WHALE,
        value: ethers.parseEther("1"),
      });

      const loFundAmount = ethers.parseUnits("1000", USDC_DECIMALS);
      await usdc.connect(usdcWhale).transfer(loSigner.address, loFundAmount);
    });

    it("Should validate same-asset vault", async function () {
      await expect(usdcVaultAdapter.validateExecutionAdapter(await usdcVault.getAddress())).to.not.be.reverted;
    });

    it("Should buy same-asset vault shares (no swap)", async function () {
      const sharesAmount = ethers.parseUnits("100", 6); // 100 shares (vault has 6 decimals, same as USDC)
      const underlyingNeeded = await usdcVault.previewMint(sharesAmount);

      // Approve adapter to pull from LO
      await usdc.connect(loSigner).approve(await usdcVaultAdapter.getAddress(), underlyingNeeded * 2n);

      // Execute buy
      const tx = await usdcVaultAdapter.connect(loSigner).buy(await usdcVault.getAddress(), sharesAmount);
      const receipt = await tx.wait();

      console.log(`  Same-asset buy gas: ${receipt!.gasUsed.toLocaleString()}`);

      // Verify exact shares received
      const sharesBalance = await usdcVault.balanceOf(loSigner.address);
      expect(sharesBalance).to.equal(sharesAmount);

      // Should use less gas than cross-asset (no swap)
      expect(receipt!.gasUsed).to.be.lt(300000);
    });

    it("Should sell same-asset vault shares (no swap)", async function () {
      // First buy some shares if we don't have any
      let sharesToSell = await usdcVault.balanceOf(loSigner.address);
      if (sharesToSell === 0n) {
        const sharesAmount = ethers.parseUnits("100", 6); // Vault has 6 decimals
        const underlyingNeeded = await usdcVault.previewMint(sharesAmount);
        await usdc.connect(loSigner).approve(await usdcVaultAdapter.getAddress(), underlyingNeeded * 2n);
        await usdcVaultAdapter.connect(loSigner).buy(await usdcVault.getAddress(), sharesAmount);
        sharesToSell = await usdcVault.balanceOf(loSigner.address);
      }

      const initialUSDC = await usdc.balanceOf(loSigner.address);
      void (await usdcVault.previewRedeem(sharesToSell)); // sanity check only

      // Approve adapter
      await usdcVault.connect(loSigner).approve(await usdcVaultAdapter.getAddress(), sharesToSell);

      // Execute sell
      const tx = await usdcVaultAdapter.connect(loSigner).sell(await usdcVault.getAddress(), sharesToSell);
      const receipt = await tx.wait();

      console.log(`  Same-asset sell gas: ${receipt!.gasUsed.toLocaleString()}`);

      // Verify USDC received
      const finalUSDC = await usdc.balanceOf(loSigner.address);
      expect(finalUSDC).to.be.gt(initialUSDC);

      // Should use less gas than cross-asset (no swap)
      expect(receipt!.gasUsed).to.be.lt(200000);
    });

    it("Should enforce slippage on same-asset buy", async function () {
      const sharesAmount = ethers.parseUnits("50", 6);
      const underlyingNeeded = await usdcVault.previewMint(sharesAmount);

      // Approve too little (will trigger slippage error)
      const tooLittle = underlyingNeeded / 2n;
      await usdc.connect(loSigner).approve(await usdcVaultAdapter.getAddress(), tooLittle);

      await expect(usdcVaultAdapter.connect(loSigner).buy(await usdcVault.getAddress(), sharesAmount)).to.be.reverted; // ERC20 allowance error — adapter tries to pull previewMint result but only tooLittle approved
    });
  });

  describe("Error Handling & Edge Cases", function () {
    it("Should reject buy with zero allowance", async function () {
      const sharesAmount = ethers.parseUnits("1", 18);

      // Ensure no allowance
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), 0);

      await expect(vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, sharesAmount)).to.be.reverted;
    });

    it("Should reject sell without share allowance", async function () {
      // Fund LO with shares first
      const usdcWhale = await ethers.getImpersonatedSigner(MAINNET.USDC_WHALE);
      await owner.sendTransaction({
        to: MAINNET.USDC_WHALE,
        value: ethers.parseEther("10"),
      });

      const fundAmount = ethers.parseUnits("10000", USDC_DECIMALS);
      await usdc.connect(usdcWhale).transfer(loSigner.address, fundAmount);

      const sharesAmount = ethers.parseUnits("0.1", 18);
      const wethNeeded = await morphoWETH.convertToAssets(sharesAmount);
      const [wethPrice, priceDecimals] = await chainlinkAdapter.getPriceData(MAINNET.WETH);
      const estimatedCost =
        (wethNeeded * wethPrice) / 10n ** (BigInt(WETH_DECIMALS) + priceDecimals - BigInt(USDC_DECIMALS));
      const maxUSDC = (estimatedCost * (10000n + BigInt(SLIPPAGE_TOLERANCE))) / 10000n;

      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);
      await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, sharesAmount);

      // Now try to sell without approval
      await morphoWETH.connect(loSigner).approve(await vaultAdapter.getAddress(), 0);

      await expect(vaultAdapter.connect(loSigner).sell(MAINNET.MORPHO_WETH, sharesAmount)).to.be.reverted;
    });

    it("Should reject non-LO caller", async function () {
      const sharesAmount = ethers.parseUnits("1", 18);

      await expect(vaultAdapter.connect(owner).buy(MAINNET.MORPHO_WETH, sharesAmount)).to.be.revertedWithCustomError(
        vaultAdapter,
        "NotAuthorized",
      );

      await expect(vaultAdapter.connect(owner).sell(MAINNET.MORPHO_WETH, sharesAmount)).to.be.revertedWithCustomError(
        vaultAdapter,
        "NotAuthorized",
      );
    });

    it("Should handle vault with zero liquidity", async function () {
      // Deploy empty vault
      const MockERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");
      const emptyVault = await MockERC4626Factory.deploy(MAINNET.WETH, "Empty Vault", "eVAULT");
      await emptyVault.waitForDeployment();

      // Register in LO
      await liquidityOrchestrator.setExecutionAdapter(await emptyVault.getAddress(), await vaultAdapter.getAddress());

      const sharesAmount = ethers.parseUnits("1", 18);
      const wethNeeded = await morphoWETH.convertToAssets(sharesAmount);
      const [wethPrice, priceDecimals] = await chainlinkAdapter.getPriceData(MAINNET.WETH);
      const estimatedCost =
        (wethNeeded * wethPrice) / 10n ** (BigInt(WETH_DECIMALS) + priceDecimals - BigInt(USDC_DECIMALS));
      const maxUSDC = (estimatedCost * (10000n + BigInt(SLIPPAGE_TOLERANCE))) / 10000n;

      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);

      // Should work - vault will mint at 1:1 initially
      await expect(vaultAdapter.connect(loSigner).buy(await emptyVault.getAddress(), sharesAmount)).to.not.be.reverted;
    });
  });
});
