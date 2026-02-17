/**
 * UniswapV3ExecutionAdapter - Unit Tests
 *
 * Tests the Uniswap V3 execution adapter in isolation with mock
 * router, quoter, factory, and config contracts.
 * Covers sell, buy, previewBuy, validateExecutionAdapter, and setAssetFee.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  UniswapV3ExecutionAdapter,
  MockUniswapV3Router,
  MockUniswapV3Factory,
  MockUniswapV3Quoter,
  MockOrionConfig,
  MockUnderlyingAsset,
} from "../../typechain-types";

describe("UniswapV3ExecutionAdapter - Unit Tests", function () {
  let owner: SignerWithAddress;
  let guardian: SignerWithAddress;
  let user: SignerWithAddress;

  let adapter: UniswapV3ExecutionAdapter;
  let mockRouter: MockUniswapV3Router;
  let mockFactory: MockUniswapV3Factory;
  let mockQuoter: MockUniswapV3Quoter;
  let config: MockOrionConfig;

  let usdc: MockUnderlyingAsset; // protocol underlying (6 decimals)
  let weth: MockUnderlyingAsset; // external asset (18 decimals)

  const USDC_DECIMALS = 6;
  const WETH_DECIMALS = 18;
  const FEE_TIER = 3000; // 0.3%
  const MOCK_POOL = "0x0000000000000000000000000000000000000001";

  before(async function () {
    [owner, guardian, user] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory("MockUnderlyingAsset");
    usdc = (await MockERC20.deploy(USDC_DECIMALS)) as unknown as MockUnderlyingAsset;
    weth = (await MockERC20.deploy(WETH_DECIMALS)) as unknown as MockUnderlyingAsset;

    // Deploy mock Uniswap contracts
    const MockRouterFactory = await ethers.getContractFactory("MockUniswapV3Router");
    mockRouter = (await MockRouterFactory.deploy()) as unknown as MockUniswapV3Router;

    const MockFactoryFactory = await ethers.getContractFactory("MockUniswapV3Factory");
    mockFactory = (await MockFactoryFactory.deploy()) as unknown as MockUniswapV3Factory;

    const MockQuoterFactory = await ethers.getContractFactory("MockUniswapV3Quoter");
    mockQuoter = (await MockQuoterFactory.deploy()) as unknown as MockUniswapV3Quoter;

    // Deploy mock config
    const MockConfigFactory = await ethers.getContractFactory("MockOrionConfig");
    config = (await MockConfigFactory.deploy(await usdc.getAddress())) as unknown as MockOrionConfig;
    await config.setGuardian(guardian.address);

    // Register pool in mock factory
    await mockFactory.setPool(await weth.getAddress(), await usdc.getAddress(), FEE_TIER, MOCK_POOL);

    // Deploy adapter under test
    const AdapterFactory = await ethers.getContractFactory("UniswapV3ExecutionAdapter");
    adapter = (await AdapterFactory.deploy(
      owner.address,
      await mockFactory.getAddress(),
      await mockRouter.getAddress(),
      await mockQuoter.getAddress(),
      await config.getAddress(),
    )) as unknown as UniswapV3ExecutionAdapter;

    // Register fee tier for WETH
    await adapter.setAssetFee(await weth.getAddress(), FEE_TIER);
  });

  describe("Constructor & Configuration", function () {
    it("Should set immutables correctly", async function () {
      expect(await adapter.SWAP_ROUTER()).to.equal(await mockRouter.getAddress());
      expect(await adapter.UNISWAP_V3_FACTORY()).to.equal(await mockFactory.getAddress());
      expect(await adapter.QUOTER()).to.equal(await mockQuoter.getAddress());
      expect(await adapter.CONFIG()).to.equal(await config.getAddress());
      expect(await adapter.UNDERLYING_ASSET()).to.equal(await usdc.getAddress());
    });

    it("Should revert constructor with zero addresses", async function () {
      const AdapterFactory = await ethers.getContractFactory("UniswapV3ExecutionAdapter");
      await expect(
        AdapterFactory.deploy(
          ethers.ZeroAddress,
          await mockFactory.getAddress(),
          await mockRouter.getAddress(),
          await mockQuoter.getAddress(),
          await config.getAddress(),
        ),
      ).to.be.reverted;
    });
  });

  describe("setAssetFee", function () {
    it("Should allow owner to set fee tier", async function () {
      const fee = await adapter.assetFee(await weth.getAddress());
      expect(fee).to.equal(FEE_TIER);
    });

    it("Should allow guardian to set fee tier", async function () {
      // Create a new token and pool for this test
      const MockERC20 = await ethers.getContractFactory("MockUnderlyingAsset");
      const newToken = await MockERC20.deploy(18);
      await mockFactory.setPool(await newToken.getAddress(), await usdc.getAddress(), 500, MOCK_POOL);

      await adapter.connect(guardian).setAssetFee(await newToken.getAddress(), 500);
      expect(await adapter.assetFee(await newToken.getAddress())).to.equal(500);
    });

    it("Should revert when called by non-owner/non-guardian", async function () {
      await expect(adapter.connect(user).setAssetFee(await weth.getAddress(), FEE_TIER)).to.be.reverted;
    });

    it("Should revert for zero address asset", async function () {
      await expect(adapter.setAssetFee(ethers.ZeroAddress, FEE_TIER)).to.be.reverted;
    });

    it("Should revert when no pool exists for the fee tier", async function () {
      // No pool registered for fee 10000
      await expect(adapter.setAssetFee(await weth.getAddress(), 10000)).to.be.reverted;
    });
  });

  describe("validateExecutionAdapter", function () {
    it("Should pass for asset with registered fee", async function () {
      await expect(adapter.validateExecutionAdapter(await weth.getAddress())).to.not.be.reverted;
    });

    it("Should revert for asset without registered fee", async function () {
      const MockERC20 = await ethers.getContractFactory("MockUnderlyingAsset");
      const unknownToken = await MockERC20.deploy(18);
      await expect(adapter.validateExecutionAdapter(await unknownToken.getAddress())).to.be.reverted;
    });
  });

  describe("sell", function () {
    it("Should execute sell (exact input swap) and return received amount", async function () {
      const sellAmount = ethers.parseUnits("1", WETH_DECIMALS); // 1 WETH
      const expectedUSDC = ethers.parseUnits("2500", USDC_DECIMALS); // 2500 USDC

      // Configure mock router
      await mockRouter.setNextSwapResult(sellAmount, expectedUSDC);

      // Mint WETH to user and approve adapter
      await weth.mint(user.address, sellAmount);
      await weth.connect(user).approve(await adapter.getAddress(), sellAmount);

      // Execute sell
      await adapter.connect(user).sell(await weth.getAddress(), sellAmount);

      // User should receive USDC (minted by mock router)
      const usdcBalance = await usdc.balanceOf(user.address);
      expect(usdcBalance).to.equal(expectedUSDC);
    });

    it("Should clean up router approval after sell", async function () {
      const sellAmount = ethers.parseUnits("0.5", WETH_DECIMALS);
      const expectedUSDC = ethers.parseUnits("1250", USDC_DECIMALS);

      await mockRouter.setNextSwapResult(sellAmount, expectedUSDC);
      await weth.mint(user.address, sellAmount);
      await weth.connect(user).approve(await adapter.getAddress(), sellAmount);

      await adapter.connect(user).sell(await weth.getAddress(), sellAmount);

      // Router allowance should be zero after swap
      const allowance = await weth.allowance(await adapter.getAddress(), await mockRouter.getAddress());
      expect(allowance).to.equal(0);
    });
  });

  describe("previewBuy", function () {
    it("Should return quoted amount from QuoterV2", async function () {
      const buyAmount = ethers.parseUnits("1", WETH_DECIMALS);
      const quotedUSDC = ethers.parseUnits("2600", USDC_DECIMALS);

      await mockQuoter.setNextQuoteResult(quotedUSDC);

      const result = await adapter.previewBuy.staticCall(await weth.getAddress(), buyAmount);
      expect(result).to.equal(quotedUSDC);
    });
  });

  describe("buy", function () {
    it("Should execute buy (exact output swap) and return spent amount", async function () {
      const buyAmount = ethers.parseUnits("1", WETH_DECIMALS); // 1 WETH
      const amountInUsed = ethers.parseUnits("2500", USDC_DECIMALS); // router uses 2500 USDC

      // Configure mock router: will consume 2500 USDC and output 1 WETH
      await mockRouter.setNextSwapResult(amountInUsed, buyAmount);

      // Mint USDC to user and approve adapter with exact amount
      const approvalAmount = amountInUsed;
      await usdc.mint(user.address, approvalAmount);
      await usdc.connect(user).approve(await adapter.getAddress(), approvalAmount);

      const balanceBefore = await usdc.balanceOf(user.address);
      await adapter.connect(user).buy(await weth.getAddress(), buyAmount);
      const balanceAfter = await usdc.balanceOf(user.address);

      // User should have spent exactly amountInUsed
      expect(balanceBefore - balanceAfter).to.equal(amountInUsed);

      // User should have received WETH
      const wethBalance = await weth.balanceOf(user.address);
      expect(wethBalance).to.be.gte(buyAmount);
    });

    it("Should refund unused USDC when router uses less than approved", async function () {
      const buyAmount = ethers.parseUnits("1", WETH_DECIMALS);
      const actualSpent = ethers.parseUnits("2400", USDC_DECIMALS);
      const approvalAmount = ethers.parseUnits("3000", USDC_DECIMALS); // over-approve

      // Router only uses 2400 of the 3000 approved
      await mockRouter.setNextSwapResult(actualSpent, buyAmount);

      await usdc.mint(user.address, approvalAmount);
      await usdc.connect(user).approve(await adapter.getAddress(), approvalAmount);

      const balanceBefore = await usdc.balanceOf(user.address);
      await adapter.connect(user).buy(await weth.getAddress(), buyAmount);
      const balanceAfter = await usdc.balanceOf(user.address);

      // User should only lose actualSpent, the rest is refunded
      expect(balanceBefore - balanceAfter).to.equal(actualSpent);
    });

    it("Should clean up router approval after buy", async function () {
      const buyAmount = ethers.parseUnits("0.5", WETH_DECIMALS);
      const amountInUsed = ethers.parseUnits("1300", USDC_DECIMALS);

      await mockRouter.setNextSwapResult(amountInUsed, buyAmount);
      await usdc.mint(user.address, amountInUsed);
      await usdc.connect(user).approve(await adapter.getAddress(), amountInUsed);

      await adapter.connect(user).buy(await weth.getAddress(), buyAmount);

      const allowance = await usdc.allowance(await adapter.getAddress(), await mockRouter.getAddress());
      expect(allowance).to.equal(0);
    });
  });
});
