/**
 * ERC4626ExecutionAdapter Tests
 *
 * Comprehensive mainnet fork testing for ERC4626 vault execution adapter.
 * Tests cover the full flow: USDC → swap → vault deposit/redeem → swap → USDC
 *
 * Test Coverage:
 * 1. Buy flow: USDC → WETH → Morpho WETH vault (via Uniswap V3)
 * 2. Sell flow: Morpho WETH vault → WETH → USDC (via Uniswap V3)
 * 3. Slippage scenarios
 * 4. Oracle failures
 * 5. Vault edge cases (fees, penalties, extreme decimals)
 * 6. Gas optimization
 * 7. Security invariants
 */

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  OrionConfig,
  ERC4626ExecutionAdapter,
  UniswapV3SwapExecutor,
  ChainlinkPriceAdapter,
  ERC4626PriceAdapter,
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

  // Yearn V3 Vaults (backup)
  YEARN_WETH: "0xc56413869c6CDf96496f2b1eF801fEDBdFA7dDB0", // yvWETH-3
  YEARN_WBTC: "0x3B96d491f067912D18563d56858Ba7d6EC67a6fa", // yvWBTC

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
  let crossAssetExecutionAdapter: ERC4626ExecutionAdapter;
  let uniswapExecutor: UniswapV3SwapExecutor;
  let chainlinkAdapter: ChainlinkPriceAdapter;
  let crossAssetPriceAdapter: ERC4626PriceAdapter;

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

    // Forking is configured in hardhat.config.ts

    [owner] = await ethers.getSigners();

    // Get contract instances
    usdc = await ethers.getContractAt("IERC20", MAINNET.USDC);
    weth = await ethers.getContractAt("IERC20", MAINNET.WETH);
    morphoWETH = await ethers.getContractAt("IERC4626", MAINNET.MORPHO_WETH);
  });

  describe("Setup and Deployment", function () {
    it("Should deploy all contracts", async function () {
      this.timeout(60000); // Deployment can take time on fork

      // Deploy minimal OrionConfig mock for testing
      const MockOrionConfigFactory = await ethers.getContractFactory("MockOrionConfig");
      orionConfig = (await MockOrionConfigFactory.deploy(MAINNET.USDC)) as OrionConfig;

      // Deploy MockLiquidityOrchestrator with slippageTolerance support
      const MockLiquidityOrchestratorFactory = await ethers.getContractFactory("MockLiquidityOrchestrator");
      liquidityOrchestrator = await MockLiquidityOrchestratorFactory.deploy(await orionConfig.getAddress());

      // Deploy Uniswap V3 executor
      const UniswapExecutorFactory = await ethers.getContractFactory("UniswapV3SwapExecutor");
      uniswapExecutor = await UniswapExecutorFactory.deploy(MAINNET.UNISWAP_ROUTER);

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

      // Configure mock OrionConfig BEFORE deploying adapters that read from it
      const mockConfig = await ethers.getContractAt("MockOrionConfig", await orionConfig.getAddress());
      await mockConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());
      await mockConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());

      // Deploy cross-asset price adapter
      const CrossAssetPriceAdapterFactory = await ethers.getContractFactory("ERC4626PriceAdapter");
      crossAssetPriceAdapter = await CrossAssetPriceAdapterFactory.deploy(await orionConfig.getAddress());

      // Deploy cross-asset execution adapter
      const CrossAssetExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
      crossAssetExecutionAdapter = await CrossAssetExecutionAdapterFactory.deploy(
        await orionConfig.getAddress(),
        await uniswapExecutor.getAddress(),
      );

      void expect(await uniswapExecutor.getAddress()).to.be.properAddress;
      void expect(await chainlinkAdapter.getAddress()).to.be.properAddress;
      void expect(await crossAssetPriceAdapter.getAddress()).to.be.properAddress;
      void expect(await crossAssetExecutionAdapter.getAddress()).to.be.properAddress;
    });

    it("Should fund test accounts with USDC", async function () {
      // Use impersonated whale to transfer USDC to liquidityOrchestrator
      // This avoids hardhat_setStorageAt which isn't supported in forked mode
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
      // Impersonate the LO contract address to make transactions from it
      const loAddress = await liquidityOrchestrator.getAddress();
      await network.provider.request({
        method: "hardhat_impersonateAccount",
        params: [loAddress],
      });

      // Get the impersonated signer
      loSigner = await ethers.getSigner(loAddress);

      // Fund it with ETH for gas
      await owner.sendTransaction({
        to: loAddress,
        value: ethers.parseEther("10"),
      });

      // Verify it has ETH
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

  describe("Buy Flow: USDC → WETH → Morpho Vault (Uniswap V3)", function () {
    let initialUSDCBalance: bigint;
    let sharesAmount: bigint;
    let estimatedUSDCCost: bigint;

    before(async function () {
      initialUSDCBalance = await usdc.balanceOf(loSigner.address);
      sharesAmount = ethers.parseUnits("1", 18); // 1 vbgtWETH share (Morpho)
    });

    it("Should calculate accurate price estimate", async function () {
      // Get vault share → WETH conversion
      const wethPerShare = await morphoWETH.convertToAssets(sharesAmount);
      console.log(`  1 vbgtWETH = ${ethers.formatUnits(wethPerShare, 18)} WETH`);

      // Get WETH → USD price from Chainlink
      const [wethPriceRaw, priceDecimals] = await chainlinkAdapter.getPriceData(MAINNET.WETH);
      const wethPriceUSD = wethPriceRaw / BigInt(10 ** (Number(priceDecimals) - 2)); // Convert to USD with 2 decimals
      console.log(`  1 WETH = $${wethPriceUSD / 100n}`);

      // Estimate USDC cost (rough calculation for logging)
      const wethAmount = wethPerShare;
      estimatedUSDCCost = (wethAmount * wethPriceUSD) / BigInt(10 ** (18 + 2 - USDC_DECIMALS));
      console.log(`  Estimated cost: ${ethers.formatUnits(estimatedUSDCCost, USDC_DECIMALS)} USDC`);
    });

    it("Should execute buy with Uniswap V3 routing", async function () {
      // Encode route params: fee tier 3000 (0.3% - most liquid pool)
      const routeParams = ethers.AbiCoder.defaultAbiCoder().encode(["uint24"], [3000]);

      // Approve adapter to spend USDC
      const maxUSDC = (estimatedUSDCCost * (10000n + BigInt(SLIPPAGE_TOLERANCE))) / 10000n;
      await usdc.connect(loSigner).approve(await crossAssetExecutionAdapter.getAddress(), maxUSDC);

      // Execute buy with routing params
      const tx = await crossAssetExecutionAdapter
        .connect(loSigner)
        ["buy(address,uint256,uint256,bytes)"](MAINNET.MORPHO_WETH, sharesAmount, estimatedUSDCCost, routeParams);

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
      // Try to buy with unrealistically low estimated cost (should revert)
      const tooLowEstimate = estimatedUSDCCost / 10n; // 10x too low
      const routeParams = ethers.AbiCoder.defaultAbiCoder().encode(["uint24"], [3000]);

      await expect(
        crossAssetExecutionAdapter
          .connect(loSigner)
          ["buy(address,uint256,uint256,bytes)"](MAINNET.MORPHO_WETH, sharesAmount, tooLowEstimate, routeParams),
      ).to.be.reverted; // Should revert due to slippage exceeded
    });
  });

  describe("Sell Flow: Morpho Vault → WETH → USDC (Uniswap V3)", function () {
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
      console.log(`  ${ethers.formatUnits(sharesToSell, 18)} yvWETH = ${ethers.formatUnits(wethToReceive, 18)} WETH`);

      // Get WETH → USD price
      const [wethPriceRaw, priceDecimals] = await chainlinkAdapter.getPriceData(MAINNET.WETH);
      const wethPriceUSD = wethPriceRaw / BigInt(10 ** (Number(priceDecimals) - 2));

      // Estimate USDC received
      estimatedUSDCReceived = (wethToReceive * BigInt(Number(wethPriceUSD))) / BigInt(10 ** (18 + 2 - USDC_DECIMALS));
      console.log(`  Estimated receive: ${ethers.formatUnits(estimatedUSDCReceived, USDC_DECIMALS)} USDC`);
    });

    it("Should execute sell with Uniswap V3 routing", async function () {
      // Encode route params
      const routeParams = ethers.AbiCoder.defaultAbiCoder().encode(["uint24"], [3000]);

      // Approve adapter to spend shares
      await morphoWETH.connect(loSigner).approve(await crossAssetExecutionAdapter.getAddress(), sharesToSell);

      // Execute sell with routing params
      const tx = await crossAssetExecutionAdapter
        .connect(loSigner)
        ["sell(address,uint256,uint256,bytes)"](MAINNET.MORPHO_WETH, sharesToSell, estimatedUSDCReceived, routeParams);

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

  describe("Price Oracle Integration", function () {
    it("Should get accurate vault price from cross-asset adapter", async function () {
      const [price, decimals] = await crossAssetPriceAdapter.getPriceData(MAINNET.MORPHO_WETH);

      console.log(`  Vault price: ${ethers.formatUnits(price, decimals)} USDC per share`);
      console.log(`  Price decimals: ${decimals}`);

      // Price should be reasonable (between $1k and $10k per share)
      const priceInUSDC = price / BigInt(10 ** (Number(decimals) - USDC_DECIMALS));
      expect(priceInUSDC).to.be.gte(ethers.parseUnits("1000", USDC_DECIMALS));
      expect(priceInUSDC).to.be.lte(ethers.parseUnits("10000", USDC_DECIMALS));
    });

    it("Should validate Chainlink security checks", async function () {
      const [price, decimals] = await chainlinkAdapter.getPriceData(MAINNET.WETH);

      // Price should be reasonable
      expect(price).to.be.gt(0);
      expect(decimals).to.equal(14); // priceAdapterDecimals
    });
  });

  describe("Edge Cases and Security", function () {
    it("Should revert on stale Chainlink data", async function () {
      // TODO: Test by mocking old updatedAt timestamp
      // This requires forking and manipulating Chainlink feed state
    });

    it("Should handle vault with withdrawal fees", async function () {
      // TODO: Test with a vault that charges withdrawal fees
      // Verify slippage tolerance covers fees
    });

    it("Should handle extreme decimal differences", async function () {
      // Test with WBTC (8 decimals) if available
      // TODO: Implement WBTC vault test
    });

    it("Should revert if swap executor fails", async function () {
      // TODO: Test with invalid route params or zero liquidity pool
    });

    it("Should maintain approval hygiene", async function () {
      // Verify all approvals are zeroed after execution
      const adapterAddress = await crossAssetExecutionAdapter.getAddress();

      const usdcAllowance = await usdc.allowance(adapterAddress, MAINNET.UNISWAP_ROUTER);
      const wethAllowance = await weth.allowance(adapterAddress, MAINNET.UNISWAP_ROUTER);
      const vaultAllowance = await weth.allowance(adapterAddress, MAINNET.MORPHO_WETH);

      expect(usdcAllowance).to.equal(0);
      expect(wethAllowance).to.equal(0);
      expect(vaultAllowance).to.equal(0);
    });
  });

  describe("Gas Benchmarking", function () {
    before(async function () {
      // Re-fund LO signer for gas benchmarking tests
      const usdcWhale = await ethers.getImpersonatedSigner(MAINNET.USDC_WHALE);
      await owner.sendTransaction({
        to: MAINNET.USDC_WHALE,
        value: ethers.parseEther("10"),
      });

      const fundAmount = ethers.parseUnits("10000", USDC_DECIMALS); // 10k USDC for benchmarking
      await usdc.connect(usdcWhale).transfer(loSigner.address, fundAmount);
    });

    it("Should benchmark buy operation gas cost", async function () {
      // Prepare for buy (smaller amount for benchmarking)
      const sharesAmount = ethers.parseUnits("0.1", 18);
      const wethPerShare = await morphoWETH.convertToAssets(sharesAmount);
      const [wethPrice, priceDecimals] = await chainlinkAdapter.getPriceData(MAINNET.WETH);

      // Price is in 14 decimals, WETH is 18 decimals, USDC is 6 decimals
      // Formula: (wethPerShare * wethPrice) / (10^18 * 10^14 / 10^6) = (wethPerShare * wethPrice) / 10^26
      const estimatedCost =
        (wethPerShare * wethPrice) / BigInt(10 ** (WETH_DECIMALS + Number(priceDecimals) - USDC_DECIMALS));
      const routeParams = ethers.AbiCoder.defaultAbiCoder().encode(["uint24"], [3000]);

      const maxUSDC = (estimatedCost * (10000n + BigInt(SLIPPAGE_TOLERANCE))) / 10000n;
      await usdc.connect(loSigner).approve(await crossAssetExecutionAdapter.getAddress(), maxUSDC);

      // Execute and measure gas
      const tx = await crossAssetExecutionAdapter
        .connect(loSigner)
        ["buy(address,uint256,uint256,bytes)"](MAINNET.MORPHO_WETH, sharesAmount, estimatedCost, routeParams);

      const receipt = await tx.wait();
      console.log(`  Buy gas cost: ${receipt!.gasUsed.toLocaleString()}`);

      // Should be under 650k gas (includes Uniswap V3 swap + ERC4626 vault deposit)
      expect(receipt!.gasUsed).to.be.lt(650000);
    });

    it("Should benchmark sell operation gas cost", async function () {
      const sharesToSell = await morphoWETH.balanceOf(loSigner.address);
      const wethToReceive = await morphoWETH.convertToAssets(sharesToSell);
      const [wethPrice, priceDecimals] = await chainlinkAdapter.getPriceData(MAINNET.WETH);

      // Price is in 14 decimals, WETH is 18 decimals, USDC is 6 decimals
      const estimatedReceive =
        (wethToReceive * wethPrice) / BigInt(10 ** (WETH_DECIMALS + Number(priceDecimals) - USDC_DECIMALS));
      const routeParams = ethers.AbiCoder.defaultAbiCoder().encode(["uint24"], [3000]);

      await morphoWETH.connect(loSigner).approve(await crossAssetExecutionAdapter.getAddress(), sharesToSell);

      const tx = await crossAssetExecutionAdapter
        .connect(loSigner)
        ["sell(address,uint256,uint256,bytes)"](MAINNET.MORPHO_WETH, sharesToSell, estimatedReceive, routeParams);

      const receipt = await tx.wait();
      console.log(`  Sell gas cost: ${receipt!.gasUsed.toLocaleString()}`);

      // Should be under 490k gas (includes ERC4626 vault redeem + Uniswap V3 swap)
      expect(receipt!.gasUsed).to.be.lt(490000);
    });
  });
});
