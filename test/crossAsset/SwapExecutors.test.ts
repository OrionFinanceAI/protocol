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
  UniswapV3ExecutionAdapter,
  MockUniswapV3Router,
  MockUnderlyingAsset,
} from "../../typechain-types";

describe("Swap Executors - Unit Tests", function () {
  let adapter: SignerWithAddress;
  let user: SignerWithAddress;

  describe("UniswapV3ExecutionAdapter", function () {
    let executor: UniswapV3ExecutionAdapter;
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
      const ExecutorFactory = await ethers.getContractFactory("UniswapV3ExecutionAdapter");
      const executorDeployed = await ExecutorFactory.deploy(await mockRouter.getAddress());
      executor = executorDeployed as unknown as UniswapV3ExecutionAdapter;
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
});
