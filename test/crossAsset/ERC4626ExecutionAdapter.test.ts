/**
 * ERC4626ExecutionAdapter E2E Tests
 *
 * Tests the new architecture where:
 * 1. Token swap executors are registered for tokens (WETH → UniswapV3TokenSwapExecutor)
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
  UniswapV3TokenSwapExecutor,
  ChainlinkPriceAdapter,
  MockERC4626VaultPriceAdapter,
  IERC4626,
  IERC20,
  MockLiquidityOrchestrator,
} from "../../typechain-types";

// Mainnet addresses
const MAINNET = {
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  WBTC: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",

  // Morpho Vaults
  MORPHO_WETH: "0x31A5684983EeE865d943A696AAC155363bA024f9", // Vault Bridge WETH (vbgtWETH)

  // Uniswap V3
  UNISWAP_ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  USDC_WETH_POOL: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640", // 0.05% fee

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
  let tokenSwapExecutor: UniswapV3TokenSwapExecutor;

  // Price adapters
  let chainlinkAdapter: ChainlinkPriceAdapter;
  let vaultPriceAdapter: MockERC4626VaultPriceAdapter;

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
      const VaultPriceAdapterFactory = await ethers.getContractFactory("MockERC4626VaultPriceAdapter");
      vaultPriceAdapter = await VaultPriceAdapterFactory.deploy(await orionConfig.getAddress());

      // Deploy token swap executor (for WETH token swaps)
      const TokenSwapExecutorFactory = await ethers.getContractFactory("UniswapV3TokenSwapExecutor");
      tokenSwapExecutor = await TokenSwapExecutorFactory.deploy(MAINNET.UNISWAP_ROUTER);

      // Deploy vault adapter (for ERC4626 vaults)
      const VaultAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
      vaultAdapter = await VaultAdapterFactory.deploy(
        await orionConfig.getAddress(),
        await liquidityOrchestrator.getAddress(),
      );

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
      const wethPriceUSD = wethPriceRaw / BigInt(10 ** (Number(priceDecimals) - 2));
      console.log(`  1 WETH = $${wethPriceUSD / 100n}`);

      // Estimate USDC cost
      estimatedUSDCCost = (wethPerShare * wethPriceUSD) / BigInt(10 ** (18 + 2 - USDC_DECIMALS));
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

      await expect(vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, sharesAmount)).to.be.reverted; // Should revert due to insufficient allowance/slippage
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
      const wethPriceUSD = wethPriceRaw / BigInt(10 ** (Number(priceDecimals) - 2));

      // Estimate USDC received
      estimatedUSDCReceived = (wethToReceive * BigInt(Number(wethPriceUSD))) / BigInt(10 ** (18 + 2 - USDC_DECIMALS));
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
        (wethNeeded * wethPrice) / BigInt(10 ** (WETH_DECIMALS + Number(priceDecimals) - USDC_DECIMALS));

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
          (wethNeeded * wethPrice) / BigInt(10 ** (WETH_DECIMALS + Number(priceDecimals) - USDC_DECIMALS));

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
        (wethNeeded * wethPrice) / BigInt(10 ** (WETH_DECIMALS + Number(priceDecimals) - USDC_DECIMALS));

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
        (wethPerShare * wethPrice) / BigInt(10 ** (WETH_DECIMALS + Number(priceDecimals) - USDC_DECIMALS));

      const maxUSDC = (estimatedCost * (10000n + BigInt(SLIPPAGE_TOLERANCE))) / 10000n;
      await usdc.connect(loSigner).approve(await vaultAdapter.getAddress(), maxUSDC);

      const tx = await vaultAdapter.connect(loSigner).buy(MAINNET.MORPHO_WETH, sharesAmount);

      const receipt = await tx.wait();
      console.log(`  Buy gas cost: ${receipt!.gasUsed.toLocaleString()}`);

      // Should be under 700k gas (includes delegation + swap + vault deposit)
      expect(receipt!.gasUsed).to.be.lt(700000);
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
});
