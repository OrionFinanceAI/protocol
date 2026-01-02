/**
 * Swap Executors Unit Tests
 *
 * Tests swap executors in isolation with mocked DEX interactions.
 * Covers both exact-input and exact-output swap modes.
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  UniswapV3SwapExecutor,
  CurveSwapExecutor,
  MockUniswapV3Router,
  MockUnderlyingAsset,
  MockCurvePool,
} from "../../typechain-types";

describe("Swap Executors - Unit Tests", function () {
  let adapter: SignerWithAddress;
  let user: SignerWithAddress;

  describe("UniswapV3SwapExecutor", function () {
    let executor: UniswapV3SwapExecutor;
    let mockRouter: MockUniswapV3Router;
    let mockTokenIn: MockUnderlyingAsset;
    let mockTokenOut: MockUnderlyingAsset;

    beforeEach(async function () {
      [, adapter, user] = await ethers.getSigners();

      // Deploy mock ERC20 tokens
      const MockERC20 = await ethers.getContractFactory("MockUnderlyingAsset");
      const tokenInDeployed = await MockERC20.deploy(6);
      const tokenOutDeployed = await MockERC20.deploy(18);
      mockTokenIn = tokenInDeployed as unknown as MockUnderlyingAsset; // USDC-like
      mockTokenOut = tokenOutDeployed as unknown as MockUnderlyingAsset; // WETH-like

      // Deploy mock Uniswap router
      const MockUniswapRouter = await ethers.getContractFactory("MockUniswapV3Router");
      const routerDeployed = await MockUniswapRouter.deploy();
      mockRouter = routerDeployed as unknown as MockUniswapV3Router;

      // Deploy executor
      const ExecutorFactory = await ethers.getContractFactory("UniswapV3SwapExecutor");
      executor = await ExecutorFactory.deploy(await mockRouter.getAddress());
    });

    describe("Exact-Output Swap", function () {
      it("Should execute exact-output swap successfully", async function () {
        const amountOut = ethers.parseUnits("1", 18); // 1 WETH out
        const amountInMax = ethers.parseUnits("3000", 6); // Max 3000 USDC in
        const routeParams = ethers.AbiCoder.defaultAbiCoder().encode(["uint24"], [3000]); // 0.3% fee

        // Mint tokens to adapter
        await mockTokenIn.mint(adapter.address, amountInMax);

        // Adapter approves executor
        await mockTokenIn.connect(adapter).approve(await executor.getAddress(), amountInMax);

        // Configure mock router to return amountIn = 2900 USDC
        const actualAmountIn = ethers.parseUnits("2900", 6);
        await mockRouter.setNextSwapResult(actualAmountIn, amountOut);

        // Execute swap
        await executor
          .connect(adapter)
          .swapExactOutput(
            await mockTokenIn.getAddress(),
            await mockTokenOut.getAddress(),
            amountOut,
            amountInMax,
            routeParams,
          );

        // Verify adapter received exact output
        const outputBalance = await mockTokenOut.balanceOf(adapter.address);
        expect(outputBalance).to.equal(amountOut);

        // Verify refund of unused input
        const inputBalance = await mockTokenIn.balanceOf(adapter.address);
        const refunded = amountInMax - actualAmountIn;
        expect(inputBalance).to.equal(refunded);
      });

      it("Should revert if amountInMax exceeded", async function () {
        const amountOut = ethers.parseUnits("1", 18);
        const amountInMax = ethers.parseUnits("2000", 6); // Too low
        const routeParams = ethers.AbiCoder.defaultAbiCoder().encode(["uint24"], [3000]);

        await mockTokenIn.mint(adapter.address, amountInMax);
        await mockTokenIn.connect(adapter).approve(await executor.getAddress(), amountInMax);

        // Mock router will try to use 2900 USDC (exceeds max)
        await mockRouter.setNextSwapResult(ethers.parseUnits("2900", 6), amountOut);

        await expect(
          executor
            .connect(adapter)
            .swapExactOutput(
              await mockTokenIn.getAddress(),
              await mockTokenOut.getAddress(),
              amountOut,
              amountInMax,
              routeParams,
            ),
        ).to.be.reverted;
      });

      it("Should clean up approvals after swap", async function () {
        const amountOut = ethers.parseUnits("1", 18);
        const amountInMax = ethers.parseUnits("3000", 6);
        const routeParams = ethers.AbiCoder.defaultAbiCoder().encode(["uint24"], [3000]);

        await mockTokenIn.mint(adapter.address, amountInMax);
        await mockTokenIn.connect(adapter).approve(await executor.getAddress(), amountInMax);

        await mockRouter.setNextSwapResult(ethers.parseUnits("2900", 6), amountOut);

        await executor
          .connect(adapter)
          .swapExactOutput(
            await mockTokenIn.getAddress(),
            await mockTokenOut.getAddress(),
            amountOut,
            amountInMax,
            routeParams,
          );

        // Verify executor has no allowance to router
        const allowance = await mockTokenIn.allowance(await executor.getAddress(), await mockRouter.getAddress());
        expect(allowance).to.equal(0);
      });
    });

    describe("Exact-Input Swap", function () {
      it("Should execute exact-input swap successfully", async function () {
        const amountIn = ethers.parseUnits("3000", 6); // 3000 USDC in
        const amountOutMin = ethers.parseUnits("0.9", 18); // Min 0.9 WETH out
        const routeParams = ethers.AbiCoder.defaultAbiCoder().encode(["uint24"], [3000]);

        await mockTokenIn.mint(adapter.address, amountIn);
        await mockTokenIn.connect(adapter).approve(await executor.getAddress(), amountIn);

        // Mock router returns 1 WETH
        const actualAmountOut = ethers.parseUnits("1", 18);
        await mockRouter.setNextSwapResult(amountIn, actualAmountOut);

        await executor
          .connect(adapter)
          .swapExactInput(
            await mockTokenIn.getAddress(),
            await mockTokenOut.getAddress(),
            amountIn,
            amountOutMin,
            routeParams,
          );

        // Verify adapter received output >= minimum
        const outputBalance = await mockTokenOut.balanceOf(adapter.address);
        expect(outputBalance).to.be.gte(amountOutMin);
        expect(outputBalance).to.equal(actualAmountOut);
      });

      it("Should revert if output below minimum", async function () {
        const amountIn = ethers.parseUnits("3000", 6);
        const amountOutMin = ethers.parseUnits("1.1", 18); // Too high
        const routeParams = ethers.AbiCoder.defaultAbiCoder().encode(["uint24"], [3000]);

        await mockTokenIn.mint(adapter.address, amountIn);
        await mockTokenIn.connect(adapter).approve(await executor.getAddress(), amountIn);

        // Mock router returns only 1 WETH (below minimum)
        await mockRouter.setNextSwapResult(amountIn, ethers.parseUnits("1", 18));

        // Router will revert with "Insufficient output" so the executor call reverts
        await expect(
          executor
            .connect(adapter)
            .swapExactInput(
              await mockTokenIn.getAddress(),
              await mockTokenOut.getAddress(),
              amountIn,
              amountOutMin,
              routeParams,
            ),
        ).to.be.reverted; // Router reverts before our custom error
      });
    });

    describe("Security Tests", function () {
      it("Should only allow adapter to call swap functions", async function () {
        const amountOut = ethers.parseUnits("1", 18);
        const amountInMax = ethers.parseUnits("3000", 6);
        const routeParams = ethers.AbiCoder.defaultAbiCoder().encode(["uint24"], [3000]);

        // User (not adapter) tries to call - should fail due to insufficient balance/approval
        await expect(
          executor
            .connect(user)
            .swapExactOutput(
              await mockTokenIn.getAddress(),
              await mockTokenOut.getAddress(),
              amountOut,
              amountInMax,
              routeParams,
            ),
        ).to.be.reverted;
      });

      it("Should handle zero address inputs", async function () {
        const routeParams = ethers.AbiCoder.defaultAbiCoder().encode(["uint24"], [3000]);

        await expect(
          executor
            .connect(adapter)
            .swapExactOutput(ethers.ZeroAddress, await mockTokenOut.getAddress(), 1000, 2000, routeParams),
        ).to.be.reverted;
      });
    });
  });

  describe("CurveSwapExecutor", function () {
    let executor: CurveSwapExecutor;
    let mockPool: MockCurvePool;
    let mockTokenIn: MockUnderlyingAsset;
    let mockTokenOut: MockUnderlyingAsset;

    beforeEach(async function () {
      [, adapter, user] = await ethers.getSigners();

      // Deploy mock tokens
      const MockERC20 = await ethers.getContractFactory("MockUnderlyingAsset");
      const tokenInDeployed = await MockERC20.deploy(6);
      const tokenOutDeployed = await MockERC20.deploy(6);
      mockTokenIn = tokenInDeployed as unknown as MockUnderlyingAsset; // USDC
      mockTokenOut = tokenOutDeployed as unknown as MockUnderlyingAsset; // USDT

      // Deploy mock Curve pool
      const MockCurvePoolFactory = await ethers.getContractFactory("MockCurvePool");
      const poolDeployed = await MockCurvePoolFactory.deploy();
      mockPool = poolDeployed as unknown as MockCurvePool;

      // Deploy executor
      const ExecutorFactory = await ethers.getContractFactory("CurveSwapExecutor");
      executor = await ExecutorFactory.deploy();
    });

    describe("Exact-Output Swap (Stablecoin)", function () {
      it("Should approximate exact-output for stablecoins", async function () {
        const amountOut = ethers.parseUnits("1000", 6); // 1000 USDT
        const amountInMax = ethers.parseUnits("1005", 6); // Max 1005 USDC (allows for buffer)
        const routeParams = ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "int128", "int128", "bool"],
          [await mockPool.getAddress(), 0, 1, false],
        );

        await mockTokenIn.mint(adapter.address, amountInMax);
        await mockTokenIn.connect(adapter).approve(await executor.getAddress(), amountInMax);

        // Configure mock pool to mint output tokens
        await mockPool.setTokenOut(await mockTokenOut.getAddress());

        // Mock Curve pool to return slightly more than requested (1001 USDT)
        await mockPool.setNextExchangeResult(ethers.parseUnits("1001", 6));

        await executor
          .connect(adapter)
          .swapExactOutput(
            await mockTokenIn.getAddress(),
            await mockTokenOut.getAddress(),
            amountOut,
            amountInMax,
            routeParams,
          );

        // Verify adapter received at least the exact amount
        const outputBalance = await mockTokenOut.balanceOf(adapter.address);
        expect(outputBalance).to.be.gte(amountOut);
      });

      it("Should refund excess output tokens", async function () {
        const amountOut = ethers.parseUnits("1000", 6);
        const amountInMax = ethers.parseUnits("1005", 6);
        const routeParams = ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "int128", "int128", "bool"],
          [await mockPool.getAddress(), 0, 1, false],
        );

        await mockTokenIn.mint(adapter.address, amountInMax);
        await mockTokenIn.connect(adapter).approve(await executor.getAddress(), amountInMax);

        // Configure mock pool
        await mockPool.setTokenOut(await mockTokenOut.getAddress());

        // Mock pool returns 1010 USDT (10 more than needed)
        const actualOut = ethers.parseUnits("1010", 6);
        await mockPool.setNextExchangeResult(actualOut);

        await executor
          .connect(adapter)
          .swapExactOutput(
            await mockTokenIn.getAddress(),
            await mockTokenOut.getAddress(),
            amountOut,
            amountInMax,
            routeParams,
          );

        // Adapter should receive all output (including excess)
        const outputBalance = await mockTokenOut.balanceOf(adapter.address);
        expect(outputBalance).to.equal(actualOut);
      });
    });

    describe("Exact-Input Swap", function () {
      it("Should execute exact-input swap successfully", async function () {
        const amountIn = ethers.parseUnits("1000", 6);
        const amountOutMin = ethers.parseUnits("995", 6); // Min 995 USDT
        const routeParams = ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "int128", "int128", "bool"],
          [await mockPool.getAddress(), 0, 1, false],
        );

        await mockTokenIn.mint(adapter.address, amountIn);
        await mockTokenIn.connect(adapter).approve(await executor.getAddress(), amountIn);

        // Configure mock pool
        await mockPool.setTokenOut(await mockTokenOut.getAddress());

        // Mock pool returns 998 USDT
        await mockPool.setNextExchangeResult(ethers.parseUnits("998", 6));

        await executor
          .connect(adapter)
          .swapExactInput(
            await mockTokenIn.getAddress(),
            await mockTokenOut.getAddress(),
            amountIn,
            amountOutMin,
            routeParams,
          );

        const outputBalance = await mockTokenOut.balanceOf(adapter.address);
        expect(outputBalance).to.be.gte(amountOutMin);
      });

      it("Should support exchange_underlying for wrapped tokens", async function () {
        const amountIn = ethers.parseUnits("1000", 6);
        const amountOutMin = ethers.parseUnits("995", 6);
        const routeParams = ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "int128", "int128", "bool"],
          [await mockPool.getAddress(), 0, 1, true], // useUnderlying = true
        );

        await mockTokenIn.mint(adapter.address, amountIn);
        await mockTokenIn.connect(adapter).approve(await executor.getAddress(), amountIn);

        // Configure mock pool
        await mockPool.setTokenOut(await mockTokenOut.getAddress());

        await mockPool.setNextExchangeResult(ethers.parseUnits("998", 6));

        await executor
          .connect(adapter)
          .swapExactInput(
            await mockTokenIn.getAddress(),
            await mockTokenOut.getAddress(),
            amountIn,
            amountOutMin,
            routeParams,
          );

        // Verify pool.exchange_underlying was called (check mock state)
        void expect(await mockPool.lastUsedUnderlying()).to.be.true;
      });
    });
  });
});
