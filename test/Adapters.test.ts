import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import {
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  MockERC4626Asset,
  MockPriceAdapter,
  MockUnderlyingAsset,
  OrionAssetERC4626ExecutionAdapter,
  OrionAssetERC4626PriceAdapter,
  OrionConfig,
  PriceAdapterRegistry,
} from "../typechain-types";

describe("Price Adapter", function () {
  let orionConfig: OrionConfig;
  let underlyingAsset: MockUnderlyingAsset;
  let mockAsset1: MockERC4626Asset;
  let priceAdapter: OrionAssetERC4626PriceAdapter;
  let priceAdapterRegistry: PriceAdapterRegistry;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let internalStatesOrchestrator: InternalStatesOrchestrator;

  let owner: SignerWithAddress;
  let automationRegistry: SignerWithAddress;
  let nonOwner: SignerWithAddress;

  beforeEach(async function () {
    [owner, automationRegistry, nonOwner] = await ethers.getSigners();

    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAssetDeployed = await MockUnderlyingAssetFactory.deploy(12);
    await underlyingAssetDeployed.waitForDeployment();
    underlyingAsset = underlyingAssetDeployed as unknown as MockUnderlyingAsset;

    const MockERC20AssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const mockAsset1Deployed = await MockERC20AssetFactory.deploy(10);
    await mockAsset1Deployed.waitForDeployment();
    mockAsset1 = mockAsset1Deployed as unknown as MockERC4626Asset;

    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    const orionConfigDeployed = await OrionConfigFactory.deploy(
      owner.address,
      nonOwner.address, // admin
      await underlyingAsset.getAddress(),
    );
    await orionConfigDeployed.waitForDeployment();
    orionConfig = orionConfigDeployed as unknown as OrionConfig;

    const OrionAssetERC4626PriceAdapterFactory = await ethers.getContractFactory("OrionAssetERC4626PriceAdapter");
    priceAdapter = (await OrionAssetERC4626PriceAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as OrionAssetERC4626PriceAdapter;
    await priceAdapter.waitForDeployment();

    const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
    priceAdapterRegistry = (await PriceAdapterRegistryFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
    )) as unknown as PriceAdapterRegistry;
    await priceAdapterRegistry.waitForDeployment();

    const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
    const liquidityOrchestratorDeployed = await LiquidityOrchestratorFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
      automationRegistry.address,
    );
    await liquidityOrchestratorDeployed.waitForDeployment();
    liquidityOrchestrator = liquidityOrchestratorDeployed as unknown as LiquidityOrchestrator;

    const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
    const internalStatesOrchestratorDeployed = await InternalStatesOrchestratorFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
      automationRegistry.address,
    );
    await internalStatesOrchestratorDeployed.waitForDeployment();
    internalStatesOrchestrator = internalStatesOrchestratorDeployed as unknown as InternalStatesOrchestrator;

    await orionConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());
    await orionConfig.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());
    await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());
  });

  describe("addWhitelistedAsset", function () {
    it("should revert with InvalidAdapter when trying to whitelist a regular ERC20 token with ERC4626 price adapter", async function () {
      const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
      const mockExecutionAdapter = await MockExecutionAdapterFactory.deploy();
      await mockExecutionAdapter.waitForDeployment();

      await expect(
        orionConfig.addWhitelistedAsset(
          await mockAsset1.getAddress(),
          await priceAdapter.getAddress(),
          await mockExecutionAdapter.getAddress(),
        ),
      ).to.be.revertedWithCustomError(priceAdapter, "InvalidAdapter");
    });

    it("should revert with InvalidAdapter when trying to whitelist a regular ERC20 token with ERC4626 execution adapter", async function () {
      const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
      const mockPriceAdapter = await MockPriceAdapterFactory.deploy();
      await mockPriceAdapter.waitForDeployment();

      const OrionAssetERC4626ExecutionAdapterFactory = await ethers.getContractFactory(
        "OrionAssetERC4626ExecutionAdapter",
      );
      const erc4626ExecutionAdapter = await OrionAssetERC4626ExecutionAdapterFactory.deploy(
        await orionConfig.getAddress(),
      );
      await erc4626ExecutionAdapter.waitForDeployment();

      await expect(
        orionConfig.addWhitelistedAsset(
          await mockAsset1.getAddress(),
          await mockPriceAdapter.getAddress(),
          await erc4626ExecutionAdapter.getAddress(),
        ),
      ).to.be.revertedWithCustomError(erc4626ExecutionAdapter, "InvalidAdapter");
    });

    it("should revert with InvalidAdapter when trying to whitelist an ERC4626 with different underlying asset using ERC4626 price adapter", async function () {
      const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
      const mockExecutionAdapter = await MockExecutionAdapterFactory.deploy();
      await mockExecutionAdapter.waitForDeployment();

      const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
      const differentUnderlyingAsset = await MockUnderlyingAssetFactory.deploy(18);
      await differentUnderlyingAsset.waitForDeployment();

      const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
      const erc4626Vault = await MockERC4626AssetFactory.deploy(
        await differentUnderlyingAsset.getAddress(),
        "Test Vault",
        "TV",
      );
      await erc4626Vault.waitForDeployment();

      await expect(
        orionConfig.addWhitelistedAsset(
          await erc4626Vault.getAddress(),
          await priceAdapter.getAddress(),
          await mockExecutionAdapter.getAddress(),
        ),
      ).to.be.revertedWithCustomError(priceAdapter, "InvalidAdapter");
    });

    it("should revert when non-owner tries to call addWhitelistedAsset", async function () {
      const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
      const mockExecutionAdapter = await MockExecutionAdapterFactory.deploy();
      await mockExecutionAdapter.waitForDeployment();

      const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
      const mockPriceAdapter = await MockPriceAdapterFactory.deploy();
      await mockPriceAdapter.waitForDeployment();

      await expect(
        orionConfig
          .connect(nonOwner)
          .addWhitelistedAsset(
            await mockAsset1.getAddress(),
            await mockPriceAdapter.getAddress(),
            await mockExecutionAdapter.getAddress(),
          ),
      ).to.be.revertedWithCustomError(orionConfig, "OwnableUnauthorizedAccount");
    });

    it("should revert with InvalidAdapter when trying to whitelist an ERC4626 with different underlying asset using ERC4626 execution adapter", async function () {
      const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
      const mockPriceAdapter = await MockPriceAdapterFactory.deploy();
      await mockPriceAdapter.waitForDeployment();

      const OrionAssetERC4626ExecutionAdapterFactory = await ethers.getContractFactory(
        "OrionAssetERC4626ExecutionAdapter",
      );
      const erc4626ExecutionAdapter = await OrionAssetERC4626ExecutionAdapterFactory.deploy(
        await orionConfig.getAddress(),
      );
      await erc4626ExecutionAdapter.waitForDeployment();

      const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
      const differentUnderlyingAsset = await MockUnderlyingAssetFactory.deploy(18);
      await differentUnderlyingAsset.waitForDeployment();

      const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
      const erc4626Vault = await MockERC4626AssetFactory.deploy(
        await differentUnderlyingAsset.getAddress(),
        "Test Vault",
        "TV",
      );
      await erc4626Vault.waitForDeployment();

      await expect(
        orionConfig.addWhitelistedAsset(
          await erc4626Vault.getAddress(),
          await mockPriceAdapter.getAddress(),
          await erc4626ExecutionAdapter.getAddress(),
        ),
      ).to.be.revertedWithCustomError(erc4626ExecutionAdapter, "InvalidAdapter");
    });
  });

  describe("ERC4626 Execution Adapter - Share Accounting", function () {
    let erc4626ExecutionAdapter: OrionAssetERC4626ExecutionAdapter;
    let erc4626Vault: MockERC4626Asset;
    let mockPriceAdapter: MockPriceAdapter;

    beforeEach(async function () {
      const OrionAssetERC4626ExecutionAdapterFactory = await ethers.getContractFactory(
        "OrionAssetERC4626ExecutionAdapter",
      );
      erc4626ExecutionAdapter = (await OrionAssetERC4626ExecutionAdapterFactory.deploy(
        await orionConfig.getAddress(),
      )) as unknown as OrionAssetERC4626ExecutionAdapter;
      await erc4626ExecutionAdapter.waitForDeployment();

      const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
      erc4626Vault = (await MockERC4626AssetFactory.deploy(
        await underlyingAsset.getAddress(),
        "Test Vault",
        "TV",
      )) as unknown as MockERC4626Asset;
      await erc4626Vault.waitForDeployment();

      // Seed vault with assets so totalAssets > 0 for validation
      const initialDeposit = ethers.parseUnits("100000", 12);
      await underlyingAsset.mint(owner.address, initialDeposit);
      await underlyingAsset.approve(await erc4626Vault.getAddress(), initialDeposit);
      await erc4626Vault.deposit(initialDeposit, owner.address);

      // Deploy mock price adapter
      const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
      mockPriceAdapter = await MockPriceAdapterFactory.deploy();
      await mockPriceAdapter.waitForDeployment();

      // Whitelist the vault to set decimals in config
      await orionConfig.addWhitelistedAsset(
        await erc4626Vault.getAddress(),
        await mockPriceAdapter.getAddress(),
        await erc4626ExecutionAdapter.getAddress(),
      );

      // Set slippage tolerance to avoid uint256.max maxAcceptableSpend
      await liquidityOrchestrator.setTargetBufferRatio(400); // 4% buffer = 2% slippage
    });

    it("should mint exact shares requested via buy(), preventing accounting drift", async function () {
      const sharesTarget = ethers.parseUnits("1000", 12);
      const underlyingAmount = ethers.parseUnits("10000", 12);

      // Mint underlying to LO
      await underlyingAsset.mint(await liquidityOrchestrator.getAddress(), underlyingAmount);

      // Impersonate LO to call buy
      await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestrator.getAddress()]);
      const loSigner = await ethers.getSigner(await liquidityOrchestrator.getAddress());

      // Set ETH balance for LO for gas
      await ethers.provider.send("hardhat_setBalance", [
        await liquidityOrchestrator.getAddress(),
        ethers.toQuantity(ethers.parseEther("1.0")),
      ]);

      // Approve adapter from LO with max allowance
      await underlyingAsset.connect(loSigner).approve(await erc4626ExecutionAdapter.getAddress(), ethers.MaxUint256);

      const balanceBefore = await erc4626Vault.balanceOf(await liquidityOrchestrator.getAddress());

      // Execute buy as LO
      await erc4626ExecutionAdapter
        .connect(loSigner)
        .buy(await erc4626Vault.getAddress(), sharesTarget, underlyingAmount);

      // Verify exact shares were minted
      const balanceAfter = await erc4626Vault.balanceOf(await liquidityOrchestrator.getAddress());
      const sharesMinted = balanceAfter - balanceBefore;

      expect(sharesMinted).to.equal(sharesTarget, "Shares minted must exactly match shares requested");

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [await liquidityOrchestrator.getAddress()]);
    });

    it("should return excess underlying when previewMint overestimates", async function () {
      const sharesTarget = ethers.parseUnits("1000", 12);
      const underlyingAmount = ethers.parseUnits("10000", 12);

      // Mint underlying to LO
      await underlyingAsset.mint(await liquidityOrchestrator.getAddress(), underlyingAmount);

      // Impersonate LO
      await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestrator.getAddress()]);
      const loSigner = await ethers.getSigner(await liquidityOrchestrator.getAddress());

      // Set ETH balance for LO for gas
      await ethers.provider.send("hardhat_setBalance", [
        await liquidityOrchestrator.getAddress(),
        ethers.toQuantity(ethers.parseEther("1.0")),
      ]);

      await underlyingAsset.connect(loSigner).approve(await erc4626ExecutionAdapter.getAddress(), ethers.MaxUint256);

      const underlyingBalanceBefore = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());

      // Execute buy from adapter
      await erc4626ExecutionAdapter
        .connect(loSigner)
        .buy(await erc4626Vault.getAddress(), sharesTarget, underlyingAmount);

      const underlyingBalanceAfter = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());

      // Verify that not all underlying was consumed (some was returned)
      const underlyingSpent = underlyingBalanceBefore - underlyingBalanceAfter;

      // Should have spent approximately sharesTarget worth (1000), not the full 2000
      expect(underlyingSpent).to.be.lessThan(underlyingAmount);
      expect(underlyingSpent).to.be.greaterThan(0n);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [await liquidityOrchestrator.getAddress()]);
    });

    it("should guarantee exact shares across multiple buy operations", async function () {
      const sharesPerBuy = ethers.parseUnits("100", 12);
      const numBuys = 5;
      const underlyingPerBuy = ethers.parseUnits("1000", 12);
      const totalUnderlying = underlyingPerBuy * BigInt(numBuys);

      // Mint enough underlying to LO
      await underlyingAsset.mint(await liquidityOrchestrator.getAddress(), totalUnderlying);

      // Impersonate LO
      await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestrator.getAddress()]);
      const loSigner = await ethers.getSigner(await liquidityOrchestrator.getAddress());

      // Set ETH balance for LO for gas
      await ethers.provider.send("hardhat_setBalance", [
        await liquidityOrchestrator.getAddress(),
        ethers.toQuantity(ethers.parseEther("1.0")),
      ]);

      await underlyingAsset.connect(loSigner).approve(await erc4626ExecutionAdapter.getAddress(), ethers.MaxUint256);

      let totalSharesReceived = 0n;

      for (let i = 0; i < numBuys; i++) {
        const balanceBefore = await erc4626Vault.balanceOf(await liquidityOrchestrator.getAddress());
        await erc4626ExecutionAdapter
          .connect(loSigner)
          .buy(await erc4626Vault.getAddress(), sharesPerBuy, underlyingPerBuy);
        const balanceAfter = await erc4626Vault.balanceOf(await liquidityOrchestrator.getAddress());

        const sharesMinted = balanceAfter - balanceBefore;
        expect(sharesMinted).to.equal(sharesPerBuy, `Buy ${i + 1} must mint exact shares`);

        totalSharesReceived += sharesMinted;
      }

      // Verify total accumulated shares
      const expectedTotalShares = sharesPerBuy * BigInt(numBuys);
      expect(totalSharesReceived).to.equal(expectedTotalShares, "Total shares must match sum of targets");

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [await liquidityOrchestrator.getAddress()]);
    });

    it("should handle sell operation correctly with exact shares", async function () {
      const sharesAmount = ethers.parseUnits("1000", 12);
      const underlyingAmount = ethers.parseUnits("10000", 12);

      // Mint underlying to LO
      await underlyingAsset.mint(await liquidityOrchestrator.getAddress(), underlyingAmount);

      // Impersonate LO
      await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestrator.getAddress()]);
      const loSigner = await ethers.getSigner(await liquidityOrchestrator.getAddress());

      // Set ETH balance for LO for gas
      await ethers.provider.send("hardhat_setBalance", [
        await liquidityOrchestrator.getAddress(),
        ethers.toQuantity(ethers.parseEther("1.0")),
      ]);

      // First buy shares via adapter
      await underlyingAsset.connect(loSigner).approve(await erc4626ExecutionAdapter.getAddress(), ethers.MaxUint256);
      await erc4626ExecutionAdapter
        .connect(loSigner)
        .buy(await erc4626Vault.getAddress(), sharesAmount, underlyingAmount);

      // Verify we have exact shares
      const shareBalance = await erc4626Vault.balanceOf(await liquidityOrchestrator.getAddress());
      expect(shareBalance).to.equal(sharesAmount);

      // Now sell those exact shares
      await erc4626Vault.connect(loSigner).approve(await erc4626ExecutionAdapter.getAddress(), sharesAmount);

      // Get the expected underlying amount from previewRedeem
      const expectedUnderlyingFromRedeem = await erc4626Vault.previewRedeem(sharesAmount);

      const underlyingBefore = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());
      await erc4626ExecutionAdapter
        .connect(loSigner)
        .sell(await erc4626Vault.getAddress(), sharesAmount, expectedUnderlyingFromRedeem);
      const underlyingAfter = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());

      // Verify shares were fully redeemed
      const finalShareBalance = await erc4626Vault.balanceOf(await liquidityOrchestrator.getAddress());
      expect(finalShareBalance).to.equal(0n, "All shares should be redeemed");

      // Verify we got underlying back
      const underlyingReceived = underlyingAfter - underlyingBefore;
      expect(underlyingReceived).to.be.greaterThan(0n, "Should receive underlying from redemption");

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [await liquidityOrchestrator.getAddress()]);
    });
  });
});
