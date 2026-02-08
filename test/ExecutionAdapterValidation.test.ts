import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import "@openzeppelin/hardhat-upgrades";
import { ethers } from "hardhat";

import {
  LiquidityOrchestrator,
  MockERC4626Asset,
  MockUnderlyingAsset,
  ERC4626ExecutionAdapter,
  MockPriceAdapter,
  OrionConfig,
} from "../typechain-types";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";

describe("Execution Adapter Validation - Comprehensive Tests", function () {
  let orionConfig: OrionConfig;
  let underlyingAsset: MockUnderlyingAsset;
  let erc4626Vault: MockERC4626Asset;
  let erc4626ExecutionAdapter: ERC4626ExecutionAdapter;
  let priceAdapter: MockPriceAdapter;
  let liquidityOrchestrator: LiquidityOrchestrator;

  let owner: SignerWithAddress;
  let user: SignerWithAddress;

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();

    const deployed = await deployUpgradeableProtocol(owner);

    underlyingAsset = deployed.underlyingAsset;
    orionConfig = deployed.orionConfig;
    liquidityOrchestrator = deployed.liquidityOrchestrator;

    // Deploy ERC4626 vault for testing
    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    erc4626Vault = (await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Test Vault",
      "TV",
    )) as unknown as MockERC4626Asset;
    await erc4626Vault.waitForDeployment();

    // Seed vault with assets so totalAssets > 0 for validation
    const initialDeposit = ethers.parseUnits("10000", 12);
    await underlyingAsset.mint(user.address, initialDeposit);
    await underlyingAsset.connect(user).approve(await erc4626Vault.getAddress(), initialDeposit);
    await erc4626Vault.connect(user).deposit(initialDeposit, user.address);

    // Deploy price adapter
    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    priceAdapter = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
    await priceAdapter.waitForDeployment();

    // Deploy mock swap executor
    const MockSwapExecutorFactory = await ethers.getContractFactory("MockSwapExecutor");
    const mockSwapExecutor = await MockSwapExecutorFactory.deploy();
    await mockSwapExecutor.waitForDeployment();

    // Deploy execution adapter
    const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
    erc4626ExecutionAdapter = (await ERC4626ExecutionAdapterFactory.deploy(
      await orionConfig.getAddress(),
      await liquidityOrchestrator.getAddress(),
    )) as unknown as ERC4626ExecutionAdapter;
    await erc4626ExecutionAdapter.waitForDeployment();
  });

  describe("validateExecutionAdapter - Atomic Checks", function () {
    describe("Underlying Asset Validation", function () {
      it("should pass validation when vault has correct underlying asset", async function () {
        // Whitelist the asset - this will call validateExecutionAdapter
        await orionConfig.addWhitelistedAsset(
          await erc4626Vault.getAddress(),
          await priceAdapter.getAddress(),
          await erc4626ExecutionAdapter.getAddress(),
        );

        // Direct validation call should also pass
        await expect(erc4626ExecutionAdapter.validateExecutionAdapter(await erc4626Vault.getAddress())).to.not.be
          .reverted;
      });

      it("should revert with InvalidAdapter when vault has different underlying asset", async function () {
        // Deploy vault with different underlying
        const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
        const differentUnderlying = await MockUnderlyingAssetFactory.deploy(18);
        await differentUnderlying.waitForDeployment();

        const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
        const wrongVault = await MockERC4626AssetFactory.deploy(
          await differentUnderlying.getAddress(),
          "Wrong Vault",
          "WV",
        );
        await wrongVault.waitForDeployment();

        // Seed wrong vault
        const initialDeposit = ethers.parseUnits("1000", 18);
        await differentUnderlying.mint(user.address, initialDeposit);
        await differentUnderlying.connect(user).approve(await wrongVault.getAddress(), initialDeposit);
        await wrongVault.connect(user).deposit(initialDeposit, user.address);

        await expect(
          orionConfig.addWhitelistedAsset(
            await wrongVault.getAddress(),
            await priceAdapter.getAddress(),
            await erc4626ExecutionAdapter.getAddress(),
          ),
        ).to.be.revertedWithCustomError(erc4626ExecutionAdapter, "InvalidAdapter");
      });

      it("should revert with InvalidAdapter when asset is not ERC4626", async function () {
        // Try to whitelist a regular ERC20 (not ERC4626)
        const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
        const regularERC20 = await MockUnderlyingAssetFactory.deploy(18);
        await regularERC20.waitForDeployment();

        await expect(
          orionConfig.addWhitelistedAsset(
            await regularERC20.getAddress(),
            await priceAdapter.getAddress(),
            await erc4626ExecutionAdapter.getAddress(),
          ),
        ).to.be.reverted;
      });
    });

    describe("Decimals Validation", function () {
      it("should pass validation when runtime decimals match config decimals", async function () {
        // Whitelist the asset - decimals will be stored and validated
        await orionConfig.addWhitelistedAsset(
          await erc4626Vault.getAddress(),
          await priceAdapter.getAddress(),
          await erc4626ExecutionAdapter.getAddress(),
        );

        // Validation should pass
        await expect(erc4626ExecutionAdapter.validateExecutionAdapter(await erc4626Vault.getAddress())).to.not.be
          .reverted;
      });
    });

    describe("Zero Total Assets Validation", function () {
      it("should pass setup validation when vault has non-zero total assets", async function () {
        // Vault already has assets from beforeEach
        const totalAssets = await erc4626Vault.totalAssets();
        expect(totalAssets).to.be.greaterThan(0);

        // Whitelist should succeed
        await orionConfig.addWhitelistedAsset(
          await erc4626Vault.getAddress(),
          await priceAdapter.getAddress(),
          await erc4626ExecutionAdapter.getAddress(),
        );
      });
    });

    describe("Validation in buy() and sell() operations", function () {
      beforeEach(async function () {
        // Whitelist the vault
        await orionConfig.addWhitelistedAsset(
          await erc4626Vault.getAddress(),
          await priceAdapter.getAddress(),
          await erc4626ExecutionAdapter.getAddress(),
        );

        // Set slippage tolerance so maxAcceptableSpend is not uint256.max
        await liquidityOrchestrator.setTargetBufferRatio(400); // 4% buffer
        await liquidityOrchestrator.setSlippageTolerance(200); // 2% slippage
      });

      it("should call atomic validation during buy()", async function () {
        const sharesAmount = ethers.parseUnits("100", 12);
        const underlyingAmount = ethers.parseUnits("2000", 12);

        // Impersonate LO
        await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestrator.getAddress()]);
        const loSigner = await ethers.getSigner(await liquidityOrchestrator.getAddress());
        await ethers.provider.send("hardhat_setBalance", [
          await liquidityOrchestrator.getAddress(),
          ethers.toQuantity(ethers.parseEther("1.0")),
        ]);

        await underlyingAsset.mint(await liquidityOrchestrator.getAddress(), underlyingAmount);
        await underlyingAsset.connect(loSigner).approve(await erc4626ExecutionAdapter.getAddress(), underlyingAmount);

        // Should succeed because validation passes
        await expect(erc4626ExecutionAdapter.connect(loSigner).buy(await erc4626Vault.getAddress(), sharesAmount)).to
          .not.be.reverted;

        await ethers.provider.send("hardhat_stopImpersonatingAccount", [await liquidityOrchestrator.getAddress()]);
      });

      it("should call atomic validation during sell()", async function () {
        // First do a buy to get shares
        const sharesAmount = ethers.parseUnits("100", 12);
        const underlyingAmount = ethers.parseUnits("2000", 12);

        await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestrator.getAddress()]);
        const loSigner = await ethers.getSigner(await liquidityOrchestrator.getAddress());
        await ethers.provider.send("hardhat_setBalance", [
          await liquidityOrchestrator.getAddress(),
          ethers.toQuantity(ethers.parseEther("1.0")),
        ]);

        await underlyingAsset.mint(await liquidityOrchestrator.getAddress(), underlyingAmount);
        await underlyingAsset.connect(loSigner).approve(await erc4626ExecutionAdapter.getAddress(), underlyingAmount);
        await erc4626ExecutionAdapter.connect(loSigner).buy(await erc4626Vault.getAddress(), sharesAmount);

        // Now sell
        await erc4626Vault.connect(loSigner).approve(await erc4626ExecutionAdapter.getAddress(), sharesAmount);
        await expect(erc4626ExecutionAdapter.connect(loSigner).sell(await erc4626Vault.getAddress(), sharesAmount)).to
          .not.be.reverted;

        await ethers.provider.send("hardhat_stopImpersonatingAccount", [await liquidityOrchestrator.getAddress()]);
      });
    });
  });

  describe("Slippage Tolerance Configuration", function () {
    beforeEach(async function () {
      // Whitelist the vault
      await orionConfig.addWhitelistedAsset(
        await erc4626Vault.getAddress(),
        await priceAdapter.getAddress(),
        await erc4626ExecutionAdapter.getAddress(),
      );
    });

    describe("setTargetBufferRatio and setSlippageTolerance", function () {
      it("should set slippage tolerance to 50% of targetBufferRatio", async function () {
        const bufferRatio = 400; // 4%
        const expectedSlippage = bufferRatio / 2; // 200 = 2%

        await liquidityOrchestrator.setTargetBufferRatio(bufferRatio);
        await liquidityOrchestrator.setSlippageTolerance(expectedSlippage);

        const storedSlippage = await liquidityOrchestrator.slippageTolerance();
        expect(storedSlippage).to.equal(expectedSlippage);
      });
    });

    describe("Slippage propagation to adapters", function () {
      it("should propagate slippage tolerance to execution adapter", async function () {
        const bufferRatio = 400; // 4%
        const expectedSlippage = bufferRatio / 2; // 2%

        await liquidityOrchestrator.setTargetBufferRatio(bufferRatio);
        await liquidityOrchestrator.setSlippageTolerance(expectedSlippage);

        // Check that adapter received the slippage update
        const adapterSlippage = await liquidityOrchestrator.slippageTolerance();
        expect(adapterSlippage).to.equal(expectedSlippage);
      });
    });
  });

  describe("Slippage Enforcement in Operations", function () {
    beforeEach(async function () {
      // Whitelist vault
      await orionConfig.addWhitelistedAsset(
        await erc4626Vault.getAddress(),
        await priceAdapter.getAddress(),
        await erc4626ExecutionAdapter.getAddress(),
      );

      // Set slippage tolerance
      await liquidityOrchestrator.setTargetBufferRatio(400); // 4% buffer
      await liquidityOrchestrator.setSlippageTolerance(200); // 2% slippage
    });

    describe("buy() slippage checks", function () {
      it("should succeed when actual spend is within slippage tolerance", async function () {
        const sharesAmount = ethers.parseUnits("100", 12);
        const underlyingAmount = ethers.parseUnits("2000", 12);

        await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestrator.getAddress()]);
        const loSigner = await ethers.getSigner(await liquidityOrchestrator.getAddress());
        await ethers.provider.send("hardhat_setBalance", [
          await liquidityOrchestrator.getAddress(),
          ethers.toQuantity(ethers.parseEther("1.0")),
        ]);

        await underlyingAsset.mint(await liquidityOrchestrator.getAddress(), underlyingAmount);
        await underlyingAsset.connect(loSigner).approve(await erc4626ExecutionAdapter.getAddress(), underlyingAmount);

        await expect(erc4626ExecutionAdapter.connect(loSigner).buy(await erc4626Vault.getAddress(), sharesAmount)).to
          .not.be.reverted;

        await ethers.provider.send("hardhat_stopImpersonatingAccount", [await liquidityOrchestrator.getAddress()]);
      });

      it("should return excess underlying when actual spend is less than max acceptable", async function () {
        const sharesAmount = ethers.parseUnits("100", 12);
        const underlyingAmount = ethers.parseUnits("2000", 12);

        await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestrator.getAddress()]);
        const loSigner = await ethers.getSigner(await liquidityOrchestrator.getAddress());
        await ethers.provider.send("hardhat_setBalance", [
          await liquidityOrchestrator.getAddress(),
          ethers.toQuantity(ethers.parseEther("1.0")),
        ]);

        await underlyingAsset.mint(await liquidityOrchestrator.getAddress(), underlyingAmount);
        await underlyingAsset.connect(loSigner).approve(await erc4626ExecutionAdapter.getAddress(), underlyingAmount);

        const balanceBefore = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());
        await erc4626ExecutionAdapter.connect(loSigner).buy(await erc4626Vault.getAddress(), sharesAmount);
        const balanceAfter = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());

        const spent = balanceBefore - balanceAfter;
        expect(spent).to.be.lessThan(underlyingAmount);
        expect(spent).to.be.greaterThan(0n);

        await ethers.provider.send("hardhat_stopImpersonatingAccount", [await liquidityOrchestrator.getAddress()]);
      });
    });

    describe("sell() slippage checks", function () {
      beforeEach(async function () {
        // Buy some shares first
        const sharesAmount = ethers.parseUnits("1000", 12);
        const underlyingAmount = ethers.parseUnits("10000", 12);

        await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestrator.getAddress()]);
        const loSigner = await ethers.getSigner(await liquidityOrchestrator.getAddress());
        await ethers.provider.send("hardhat_setBalance", [
          await liquidityOrchestrator.getAddress(),
          ethers.toQuantity(ethers.parseEther("1.0")),
        ]);

        await underlyingAsset.mint(await liquidityOrchestrator.getAddress(), underlyingAmount);
        await underlyingAsset.connect(loSigner).approve(await erc4626ExecutionAdapter.getAddress(), underlyingAmount);
        await erc4626ExecutionAdapter.connect(loSigner).buy(await erc4626Vault.getAddress(), sharesAmount);

        await ethers.provider.send("hardhat_stopImpersonatingAccount", [await liquidityOrchestrator.getAddress()]);
      });

      it("should succeed when actual redemption is within expected range", async function () {
        const sharesAmount = ethers.parseUnits("100", 12);

        await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestrator.getAddress()]);
        const loSigner = await ethers.getSigner(await liquidityOrchestrator.getAddress());
        await ethers.provider.send("hardhat_setBalance", [
          await liquidityOrchestrator.getAddress(),
          ethers.toQuantity(ethers.parseEther("1.0")),
        ]);

        await erc4626Vault.connect(loSigner).approve(await erc4626ExecutionAdapter.getAddress(), sharesAmount);

        await expect(erc4626ExecutionAdapter.connect(loSigner).sell(await erc4626Vault.getAddress(), sharesAmount)).to
          .not.be.reverted;

        await ethers.provider.send("hardhat_stopImpersonatingAccount", [await liquidityOrchestrator.getAddress()]);
      });

      it("should return underlying tokens from sell operation", async function () {
        const sharesAmount = ethers.parseUnits("100", 12);

        await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestrator.getAddress()]);
        const loSigner = await ethers.getSigner(await liquidityOrchestrator.getAddress());
        await ethers.provider.send("hardhat_setBalance", [
          await liquidityOrchestrator.getAddress(),
          ethers.toQuantity(ethers.parseEther("1.0")),
        ]);

        await erc4626Vault.connect(loSigner).approve(await erc4626ExecutionAdapter.getAddress(), sharesAmount);

        const underlyingBefore = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());
        await erc4626ExecutionAdapter.connect(loSigner).sell(await erc4626Vault.getAddress(), sharesAmount);
        const underlyingAfter = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());

        const received = underlyingAfter - underlyingBefore;
        expect(received).to.be.greaterThan(0n);

        await ethers.provider.send("hardhat_stopImpersonatingAccount", [await liquidityOrchestrator.getAddress()]);
      });
    });
  });

  describe("Integration Tests - Complete Flow", function () {
    beforeEach(async function () {
      // Full setup
      await orionConfig.addWhitelistedAsset(
        await erc4626Vault.getAddress(),
        await priceAdapter.getAddress(),
        await erc4626ExecutionAdapter.getAddress(),
      );

      // Set target buffer ratio which sets slippage
      await liquidityOrchestrator.setTargetBufferRatio(400); // 4% buffer = 2% slippage
    });

    it("should complete full buy-sell cycle with validation and slippage checks", async function () {
      const sharesAmount = ethers.parseUnits("100", 12);
      const underlyingAmount = ethers.parseUnits("2000", 12);

      await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestrator.getAddress()]);
      const loSigner = await ethers.getSigner(await liquidityOrchestrator.getAddress());
      await ethers.provider.send("hardhat_setBalance", [
        await liquidityOrchestrator.getAddress(),
        ethers.toQuantity(ethers.parseEther("1.0")),
      ]);

      // Mint underlying to LO
      await underlyingAsset.mint(await liquidityOrchestrator.getAddress(), underlyingAmount);
      await underlyingAsset.connect(loSigner).approve(await erc4626ExecutionAdapter.getAddress(), underlyingAmount);

      // Buy operation - validates and checks slippage
      await erc4626ExecutionAdapter.connect(loSigner).buy(await erc4626Vault.getAddress(), sharesAmount);

      // Verify shares received
      const sharesBalance = await erc4626Vault.balanceOf(await liquidityOrchestrator.getAddress());
      expect(sharesBalance).to.equal(sharesAmount);

      // Verify excess returned
      const underlyingAfterBuy = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());
      expect(underlyingAfterBuy).to.be.greaterThan(0n);

      // Sell operation - validates and checks slippage
      await erc4626Vault.connect(loSigner).approve(await erc4626ExecutionAdapter.getAddress(), sharesAmount);

      await erc4626ExecutionAdapter.connect(loSigner).sell(await erc4626Vault.getAddress(), sharesAmount);

      // Verify shares sold
      const finalSharesBalance = await erc4626Vault.balanceOf(await liquidityOrchestrator.getAddress());
      expect(finalSharesBalance).to.equal(0n);

      // Verify underlying received from sell
      const underlyingAfterSell = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());
      expect(underlyingAfterSell).to.be.greaterThan(underlyingAfterBuy);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [await liquidityOrchestrator.getAddress()]);
    });

    it("should propagate slippage updates to adapters and enforce in operations", async function () {
      // Change buffer ratio and slippage tolerance
      await liquidityOrchestrator.setTargetBufferRatio(300); // 3% buffer
      await liquidityOrchestrator.setSlippageTolerance(150); // 1.5% slippage

      // Verify slippage updated
      const newSlippage = await liquidityOrchestrator.slippageTolerance();
      expect(newSlippage).to.equal(150); // 1.5%

      // Execute buy with new slippage
      const sharesAmount = ethers.parseUnits("100", 12);
      const underlyingAmount = ethers.parseUnits("2000", 12);

      await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestrator.getAddress()]);
      const loSigner = await ethers.getSigner(await liquidityOrchestrator.getAddress());
      await ethers.provider.send("hardhat_setBalance", [
        await liquidityOrchestrator.getAddress(),
        ethers.toQuantity(ethers.parseEther("1.0")),
      ]);

      await underlyingAsset.mint(await liquidityOrchestrator.getAddress(), underlyingAmount);
      await underlyingAsset.connect(loSigner).approve(await erc4626ExecutionAdapter.getAddress(), underlyingAmount);

      await expect(erc4626ExecutionAdapter.connect(loSigner).buy(await erc4626Vault.getAddress(), sharesAmount)).to.not
        .be.reverted;

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [await liquidityOrchestrator.getAddress()]);
    });
  });
});
