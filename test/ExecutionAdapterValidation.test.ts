import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import {
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  MockERC4626Asset,
  MockUnderlyingAsset,
  OrionAssetERC4626ExecutionAdapter,
  OrionAssetERC4626PriceAdapter,
  OrionConfig,
  PriceAdapterRegistry,
} from "../typechain-types";

describe("Execution Adapter Validation - Comprehensive Tests", function () {
  let orionConfig: OrionConfig;
  let underlyingAsset: MockUnderlyingAsset;
  let erc4626Vault: MockERC4626Asset;
  let erc4626ExecutionAdapter: OrionAssetERC4626ExecutionAdapter;
  let priceAdapter: OrionAssetERC4626PriceAdapter;
  let priceAdapterRegistry: PriceAdapterRegistry;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let internalStatesOrchestrator: InternalStatesOrchestrator;

  let owner: SignerWithAddress;
  let admin: SignerWithAddress;
  let automationRegistry: SignerWithAddress;
  let user: SignerWithAddress;

  beforeEach(async function () {
    [owner, admin, automationRegistry, user] = await ethers.getSigners();

    // Deploy underlying asset (12 decimals)
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAssetDeployed = await MockUnderlyingAssetFactory.deploy(12);
    await underlyingAssetDeployed.waitForDeployment();
    underlyingAsset = underlyingAssetDeployed as unknown as MockUnderlyingAsset;

    // Deploy ERC4626 vault
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

    // Deploy OrionConfig
    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    const orionConfigDeployed = await OrionConfigFactory.deploy(
      owner.address,
      admin.address,
      await underlyingAsset.getAddress(),
    );
    await orionConfigDeployed.waitForDeployment();
    orionConfig = orionConfigDeployed as unknown as OrionConfig;

    // Deploy price adapter
    const OrionAssetERC4626PriceAdapterFactory = await ethers.getContractFactory("OrionAssetERC4626PriceAdapter");
    priceAdapter = (await OrionAssetERC4626PriceAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as OrionAssetERC4626PriceAdapter;
    await priceAdapter.waitForDeployment();

    // Deploy price adapter registry
    const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
    priceAdapterRegistry = (await PriceAdapterRegistryFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
    )) as unknown as PriceAdapterRegistry;
    await priceAdapterRegistry.waitForDeployment();

    // Deploy LiquidityOrchestrator
    const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
    const liquidityOrchestratorDeployed = await LiquidityOrchestratorFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
      automationRegistry.address,
    );
    await liquidityOrchestratorDeployed.waitForDeployment();
    liquidityOrchestrator = liquidityOrchestratorDeployed as unknown as LiquidityOrchestrator;

    // Deploy InternalStatesOrchestrator
    const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
    const internalStatesOrchestratorDeployed = await InternalStatesOrchestratorFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
      automationRegistry.address,
    );
    await internalStatesOrchestratorDeployed.waitForDeployment();
    internalStatesOrchestrator = internalStatesOrchestratorDeployed as unknown as InternalStatesOrchestrator;

    // Wire up orchestrators
    await orionConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());
    await orionConfig.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());
    await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

    // Deploy execution adapter
    const OrionAssetERC4626ExecutionAdapterFactory = await ethers.getContractFactory(
      "OrionAssetERC4626ExecutionAdapter",
    );
    erc4626ExecutionAdapter = (await OrionAssetERC4626ExecutionAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as OrionAssetERC4626ExecutionAdapter;
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
        ).to.be.revertedWithCustomError(erc4626ExecutionAdapter, "InvalidAdapter");
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

      it("should revert buy() when vault has zero total assets", async function () {
        // Whitelist the vault (has assets from beforeEach)
        await orionConfig.addWhitelistedAsset(
          await erc4626Vault.getAddress(),
          await priceAdapter.getAddress(),
          await erc4626ExecutionAdapter.getAddress(),
        );

        // Deploy a fresh vault with zero assets
        const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
        const emptyVault = await MockERC4626AssetFactory.deploy(
          await underlyingAsset.getAddress(),
          "Empty Vault",
          "EV",
        );
        await emptyVault.waitForDeployment();

        // Seed it to pass whitelisting
        const tempDeposit = ethers.parseUnits("1000", 12);
        await underlyingAsset.mint(user.address, tempDeposit);
        await underlyingAsset.connect(user).approve(await emptyVault.getAddress(), tempDeposit);
        await emptyVault.connect(user).deposit(tempDeposit, user.address);

        // Whitelist it
        await orionConfig.addWhitelistedAsset(
          await emptyVault.getAddress(),
          await priceAdapter.getAddress(),
          await erc4626ExecutionAdapter.getAddress(),
        );

        // Now withdraw all assets to make it zero
        await emptyVault.connect(user).redeem(await emptyVault.balanceOf(user.address), user.address, user.address);
        expect(await emptyVault.totalAssets()).to.equal(0);

        // Try to buy - should fail with ZeroTotalAssets
        const sharesAmount = ethers.parseUnits("100", 12);
        const underlyingAmount = ethers.parseUnits("1000", 12);

        // Impersonate LO
        await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestrator.getAddress()]);
        const loSigner = await ethers.getSigner(await liquidityOrchestrator.getAddress());
        await ethers.provider.send("hardhat_setBalance", [
          await liquidityOrchestrator.getAddress(),
          ethers.toQuantity(ethers.parseEther("1.0")),
        ]);

        await underlyingAsset.mint(await liquidityOrchestrator.getAddress(), underlyingAmount);
        await underlyingAsset.connect(loSigner).approve(await erc4626ExecutionAdapter.getAddress(), underlyingAmount);

        await expect(
          erc4626ExecutionAdapter.connect(loSigner).buy(await emptyVault.getAddress(), sharesAmount),
        ).to.be.revertedWithCustomError(erc4626ExecutionAdapter, "ZeroTotalAssets");

        await ethers.provider.send("hardhat_stopImpersonatingAccount", [await liquidityOrchestrator.getAddress()]);
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
        await liquidityOrchestrator.setTargetBufferRatio(400); // 4% buffer = 2% slippage
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

    describe("setSlippageTolerance", function () {
      it("should allow LiquidityOrchestrator to set slippage tolerance", async function () {
        const newSlippage = 500; // 5%

        await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestrator.getAddress()]);
        const loSigner = await ethers.getSigner(await liquidityOrchestrator.getAddress());
        await ethers.provider.send("hardhat_setBalance", [
          await liquidityOrchestrator.getAddress(),
          ethers.toQuantity(ethers.parseEther("1.0")),
        ]);

        await erc4626ExecutionAdapter.connect(loSigner).setSlippageTolerance(newSlippage);

        const storedSlippage = await erc4626ExecutionAdapter.slippageTolerance();
        expect(storedSlippage).to.equal(newSlippage);

        await ethers.provider.send("hardhat_stopImpersonatingAccount", [await liquidityOrchestrator.getAddress()]);
      });

      it("should revert when non-LO tries to set slippage tolerance", async function () {
        const newSlippage = 500;

        await expect(
          erc4626ExecutionAdapter.connect(owner).setSlippageTolerance(newSlippage),
        ).to.be.revertedWithCustomError(erc4626ExecutionAdapter, "NotAuthorized");
      });
    });

    describe("setTargetBufferRatio sets slippage to 50%", function () {
      it("should set slippage tolerance to 50% of targetBufferRatio", async function () {
        const bufferRatio = 400; // 4%
        const expectedSlippage = bufferRatio / 2; // 200 = 2%

        await liquidityOrchestrator.setTargetBufferRatio(bufferRatio);

        const storedSlippage = await liquidityOrchestrator.slippageTolerance();
        expect(storedSlippage).to.equal(expectedSlippage);
      });

      it("should update slippage when buffer ratio changes", async function () {
        // Set initial buffer ratio
        await liquidityOrchestrator.setTargetBufferRatio(400);
        let slippage = await liquidityOrchestrator.slippageTolerance();
        expect(slippage).to.equal(200);

        // Change buffer ratio
        await liquidityOrchestrator.setTargetBufferRatio(500);
        slippage = await liquidityOrchestrator.slippageTolerance();
        expect(slippage).to.equal(250);
      });
    });

    describe("Slippage propagation to adapters", function () {
      it("should propagate slippage tolerance to execution adapter", async function () {
        const bufferRatio = 400; // 4%
        const expectedSlippage = bufferRatio / 2; // 2%

        await liquidityOrchestrator.setTargetBufferRatio(bufferRatio);

        // Check that adapter received the slippage update
        const adapterSlippage = await erc4626ExecutionAdapter.slippageTolerance();
        expect(adapterSlippage).to.equal(expectedSlippage);
      });

      it("should handle multiple adapters", async function () {
        // Deploy second vault and adapter
        const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
        const vault2 = await MockERC4626AssetFactory.deploy(await underlyingAsset.getAddress(), "Vault 2", "V2");
        await vault2.waitForDeployment();

        // Seed vault2
        const deposit2 = ethers.parseUnits("5000", 12);
        await underlyingAsset.mint(user.address, deposit2);
        await underlyingAsset.connect(user).approve(await vault2.getAddress(), deposit2);
        await vault2.connect(user).deposit(deposit2, user.address);

        const OrionAssetERC4626ExecutionAdapterFactory = await ethers.getContractFactory(
          "OrionAssetERC4626ExecutionAdapter",
        );
        const adapter2 = await OrionAssetERC4626ExecutionAdapterFactory.deploy(await orionConfig.getAddress());
        await adapter2.waitForDeployment();

        // Whitelist second vault
        await orionConfig.addWhitelistedAsset(
          await vault2.getAddress(),
          await priceAdapter.getAddress(),
          await adapter2.getAddress(),
        );

        // Set buffer ratio - should propagate to both adapters
        const bufferRatio = 300;
        const expectedSlippage = bufferRatio / 2;

        await liquidityOrchestrator.setTargetBufferRatio(bufferRatio);

        const slippage1 = await erc4626ExecutionAdapter.slippageTolerance();
        const slippage2 = await adapter2.slippageTolerance();

        expect(slippage1).to.equal(expectedSlippage);
        expect(slippage2).to.equal(expectedSlippage);
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
      await liquidityOrchestrator.setTargetBufferRatio(400); // 4% buffer = 2% slippage
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

  describe("updateTokenDecimals", function () {
    beforeEach(async function () {
      // Whitelist the vault
      await orionConfig.addWhitelistedAsset(
        await erc4626Vault.getAddress(),
        await priceAdapter.getAddress(),
        await erc4626ExecutionAdapter.getAddress(),
      );
    });

    it("should allow admin to update token decimals", async function () {
      const decimalsBefore = await orionConfig.getTokenDecimals(await erc4626Vault.getAddress());
      expect(decimalsBefore).to.equal(12);

      await expect(orionConfig.connect(admin).updateTokenDecimals(await erc4626Vault.getAddress()))
        .to.emit(orionConfig, "TokenDecimalsUpdated")
        .withArgs(await erc4626Vault.getAddress(), 12);

      const decimalsAfter = await orionConfig.getTokenDecimals(await erc4626Vault.getAddress());
      expect(decimalsAfter).to.equal(12);
    });

    it("should revert when non-admin tries to update decimals", async function () {
      await expect(
        orionConfig.connect(user).updateTokenDecimals(await erc4626Vault.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "NotAuthorized");
    });

    it("should revert when asset is not whitelisted", async function () {
      const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
      const newVault = await MockERC4626AssetFactory.deploy(await underlyingAsset.getAddress(), "New Vault", "NV");
      await newVault.waitForDeployment();

      await expect(
        orionConfig.connect(admin).updateTokenDecimals(await newVault.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "TokenNotWhitelisted");
    });
  });

  describe("emergencyUpdateExecutionAdapter", function () {
    beforeEach(async function () {
      // Whitelist the vault
      await orionConfig.addWhitelistedAsset(
        await erc4626Vault.getAddress(),
        await priceAdapter.getAddress(),
        await erc4626ExecutionAdapter.getAddress(),
      );
    });

    it("should revert when not in BuyingLeg phase", async function () {
      // Default phase is Idle, not BuyingLeg
      const currentPhase = await liquidityOrchestrator.currentPhase();
      expect(currentPhase).to.equal(0); // 0 = Idle

      // Deploy new adapter
      const OrionAssetERC4626ExecutionAdapterFactory = await ethers.getContractFactory(
        "OrionAssetERC4626ExecutionAdapter",
      );
      const newAdapter = await OrionAssetERC4626ExecutionAdapterFactory.deploy(await orionConfig.getAddress());
      await newAdapter.waitForDeployment();

      await expect(
        orionConfig
          .connect(admin)
          .emergencyUpdateExecutionAdapter(await erc4626Vault.getAddress(), await newAdapter.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "InvalidState");
    });

    it("should revert when asset is not whitelisted", async function () {
      const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
      const newVault = await MockERC4626AssetFactory.deploy(await underlyingAsset.getAddress(), "New Vault", "NV");
      await newVault.waitForDeployment();

      const OrionAssetERC4626ExecutionAdapterFactory = await ethers.getContractFactory(
        "OrionAssetERC4626ExecutionAdapter",
      );
      const newAdapter = await OrionAssetERC4626ExecutionAdapterFactory.deploy(await orionConfig.getAddress());
      await newAdapter.waitForDeployment();

      await expect(
        orionConfig
          .connect(admin)
          .emergencyUpdateExecutionAdapter(await newVault.getAddress(), await newAdapter.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "TokenNotWhitelisted");
    });

    it("should revert when non-admin tries to call emergency update", async function () {
      const OrionAssetERC4626ExecutionAdapterFactory = await ethers.getContractFactory(
        "OrionAssetERC4626ExecutionAdapter",
      );
      const newAdapter = await OrionAssetERC4626ExecutionAdapterFactory.deploy(await orionConfig.getAddress());
      await newAdapter.waitForDeployment();

      await expect(
        orionConfig
          .connect(user)
          .emergencyUpdateExecutionAdapter(await erc4626Vault.getAddress(), await newAdapter.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "NotAuthorized");
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
      const underlyingBefore = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());
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
      // Change buffer ratio
      await liquidityOrchestrator.setTargetBufferRatio(300); // 3% buffer = 1.5% slippage

      // Verify slippage updated
      const newSlippage = await erc4626ExecutionAdapter.slippageTolerance();
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
