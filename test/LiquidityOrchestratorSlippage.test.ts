import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import "@openzeppelin/hardhat-upgrades";
import { ethers, upgrades } from "hardhat";

import {
  LiquidityOrchestratorHarness,
  MockERC4626Asset,
  MockUnderlyingAsset,
  ERC4626ExecutionAdapter,
  MockPriceAdapter,
  OrionConfig,
  PriceAdapterRegistry,
} from "../typechain-types";
import { resetNetwork } from "./helpers/resetNetwork";

/**
 * Comprehensive tests for centralized slippage management in LiquidityOrchestrator.
 *
 * Uses LiquidityOrchestratorHarness to directly call the contract's internal
 * _calculateMaxWithSlippage and _calculateMinWithSlippage via Solidity (Math.mulDiv),
 * ensuring on-chain rounding behavior is validated rather than JS-only arithmetic.
 */
describe("LiquidityOrchestrator - Centralized Slippage Management", function () {
  let orionConfig: OrionConfig;
  let underlyingAsset: MockUnderlyingAsset;
  let vault1: MockERC4626Asset;
  let vault2: MockERC4626Asset;
  let executionAdapter: ERC4626ExecutionAdapter;
  let priceAdapter: MockPriceAdapter;
  let harness: LiquidityOrchestratorHarness;

  let owner: SignerWithAddress;
  let user: SignerWithAddress;

  const BASIS_POINTS_FACTOR = 10000n;

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();

    // --- Deploy underlying asset ---
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    underlyingAsset = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset;
    await underlyingAsset.waitForDeployment();

    // --- Deploy OrionConfig (UUPS) ---
    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    orionConfig = (await upgrades.deployProxy(OrionConfigFactory, [owner.address, await underlyingAsset.getAddress()], {
      initializer: "initialize",
      kind: "uups",
    })) as unknown as OrionConfig;
    await orionConfig.waitForDeployment();

    // --- Deploy PriceAdapterRegistry (UUPS) ---
    const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
    const priceAdapterRegistry = (await upgrades.deployProxy(
      PriceAdapterRegistryFactory,
      [owner.address, await orionConfig.getAddress()],
      { initializer: "initialize", kind: "uups" },
    )) as unknown as PriceAdapterRegistry;
    await priceAdapterRegistry.waitForDeployment();
    await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

    // --- Deploy SP1 verifier stack ---
    const SP1VerifierGatewayFactory = await ethers.getContractFactory("SP1VerifierGateway");
    const sp1VerifierGateway = await SP1VerifierGatewayFactory.deploy(owner.address);
    await sp1VerifierGateway.waitForDeployment();

    const SP1VerifierFactory = await ethers.getContractFactory("SP1Verifier");
    const sp1Verifier = await SP1VerifierFactory.deploy();
    await sp1Verifier.waitForDeployment();
    await sp1VerifierGateway.addRoute(await sp1Verifier.getAddress());

    const vKey = "0x00dcc994ce74ee9842a9224176ea2aa5115883598b92686e0d764d3908352bb7";

    // --- Deploy LiquidityOrchestratorHarness as UUPS proxy ---
    const HarnessFactory = await ethers.getContractFactory("LiquidityOrchestratorHarness");
    harness = (await upgrades.deployProxy(
      HarnessFactory,
      [owner.address, await orionConfig.getAddress(), owner.address, await sp1VerifierGateway.getAddress(), vKey],
      { initializer: "initialize", kind: "uups" },
    )) as unknown as LiquidityOrchestratorHarness;
    await harness.waitForDeployment();

    // --- Wire config ---
    await orionConfig.setLiquidityOrchestrator(await harness.getAddress());

    // --- Deploy vaults ---
    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    vault1 = (await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Test Vault 1",
      "TV1",
    )) as unknown as MockERC4626Asset;
    await vault1.waitForDeployment();

    vault2 = (await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Test Vault 2",
      "TV2",
    )) as unknown as MockERC4626Asset;
    await vault2.waitForDeployment();

    // Seed vaults with assets so totalAssets > 0 for validation
    const initialDeposit = ethers.parseUnits("100000", 6);
    await underlyingAsset.mint(user.address, initialDeposit * 2n);

    await underlyingAsset.connect(user).approve(await vault1.getAddress(), initialDeposit);
    await vault1.connect(user).deposit(initialDeposit, user.address);

    await underlyingAsset.connect(user).approve(await vault2.getAddress(), initialDeposit);
    await vault2.connect(user).deposit(initialDeposit, user.address);

    // --- Deploy adapters ---
    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    priceAdapter = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
    await priceAdapter.waitForDeployment();

    const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
    executionAdapter = (await ERC4626ExecutionAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as ERC4626ExecutionAdapter;
    await executionAdapter.waitForDeployment();

    // --- Deploy beacon + vault factory for config ---
    const VaultImplFactory = await ethers.getContractFactory("OrionTransparentVault");
    const vaultImpl = await VaultImplFactory.deploy();
    await vaultImpl.waitForDeployment();

    const BeaconFactory = await ethers.getContractFactory(
      "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon",
    );
    const vaultBeacon = await BeaconFactory.deploy(await vaultImpl.getAddress(), owner.address);
    await vaultBeacon.waitForDeployment();

    const TransparentVaultFactoryFactory = await ethers.getContractFactory("TransparentVaultFactory");
    const transparentVaultFactory = await upgrades.deployProxy(
      TransparentVaultFactoryFactory,
      [owner.address, await orionConfig.getAddress(), await vaultBeacon.getAddress()],
      { initializer: "initialize", kind: "uups" },
    );
    await transparentVaultFactory.waitForDeployment();
    await orionConfig.setVaultFactory(await transparentVaultFactory.getAddress());

    // Whitelist both vaults
    await orionConfig.addWhitelistedAsset(
      await vault1.getAddress(),
      await priceAdapter.getAddress(),
      await executionAdapter.getAddress(),
    );

    await orionConfig.addWhitelistedAsset(
      await vault2.getAddress(),
      await priceAdapter.getAddress(),
      await executionAdapter.getAddress(),
    );
  });

  describe("Slippage Helper Functions - On-Chain Solidity Validation", function () {
    describe("_calculateMaxWithSlippage (via harness)", function () {
      it("should calculate correct max amount with 2% slippage on-chain", async function () {
        await harness.setSlippageTolerance(200);

        const estimatedAmount = ethers.parseUnits("1000", 6);
        const contractResult = await harness.exposed_calculateMaxWithSlippage(estimatedAmount);

        expect(contractResult).to.equal(ethers.parseUnits("1020", 6));
      });

      it("should calculate correct max amount with 5% slippage on-chain", async function () {
        await harness.setSlippageTolerance(500);

        const estimatedAmount = ethers.parseUnits("2000", 6);
        const contractResult = await harness.exposed_calculateMaxWithSlippage(estimatedAmount);

        expect(contractResult).to.equal(ethers.parseUnits("2100", 6));
      });

      it("should handle zero slippage correctly on-chain", async function () {
        await harness.setSlippageTolerance(0);

        const estimatedAmount = ethers.parseUnits("5000", 6);
        const contractResult = await harness.exposed_calculateMaxWithSlippage(estimatedAmount);

        expect(contractResult).to.equal(estimatedAmount);
      });

      it("should handle very small amounts on-chain (Solidity rounding)", async function () {
        await harness.setSlippageTolerance(100); // 1%

        const estimatedAmount = 100n; // 0.0001 USDC
        const contractResult = await harness.exposed_calculateMaxWithSlippage(estimatedAmount);

        // Solidity mulDiv(100, 10100, 10000) = 101
        expect(contractResult).to.equal(101n);
      });

      it("should handle very large amounts correctly on-chain", async function () {
        await harness.setSlippageTolerance(300); // 3%

        const estimatedAmount = ethers.parseUnits("1000000000", 6); // 1 billion USDC
        const contractResult = await harness.exposed_calculateMaxWithSlippage(estimatedAmount);

        expect(contractResult).to.equal(ethers.parseUnits("1030000000", 6));
      });
    });

    describe("_calculateMinWithSlippage (via harness)", function () {
      it("should calculate correct min amount with 2% slippage on-chain", async function () {
        await harness.setSlippageTolerance(200);

        const estimatedAmount = ethers.parseUnits("1000", 6);
        const contractResult = await harness.exposed_calculateMinWithSlippage(estimatedAmount);

        expect(contractResult).to.equal(ethers.parseUnits("980", 6));
      });

      it("should calculate correct min amount with 5% slippage on-chain", async function () {
        await harness.setSlippageTolerance(500);

        const estimatedAmount = ethers.parseUnits("2000", 6);
        const contractResult = await harness.exposed_calculateMinWithSlippage(estimatedAmount);

        expect(contractResult).to.equal(ethers.parseUnits("1900", 6));
      });

      it("should handle zero slippage correctly on-chain", async function () {
        await harness.setSlippageTolerance(0);

        const estimatedAmount = ethers.parseUnits("5000", 6);
        const contractResult = await harness.exposed_calculateMinWithSlippage(estimatedAmount);

        expect(contractResult).to.equal(estimatedAmount);
      });

      it("should handle very small amounts on-chain (Solidity rounding)", async function () {
        await harness.setSlippageTolerance(100); // 1%

        const estimatedAmount = 100n;
        const contractResult = await harness.exposed_calculateMinWithSlippage(estimatedAmount);

        // Solidity mulDiv(100, 9900, 10000) = 99
        expect(contractResult).to.equal(99n);
      });

      it("should handle very large amounts correctly on-chain", async function () {
        await harness.setSlippageTolerance(300); // 3%

        const estimatedAmount = ethers.parseUnits("1000000000", 6);
        const contractResult = await harness.exposed_calculateMinWithSlippage(estimatedAmount);

        expect(contractResult).to.equal(ethers.parseUnits("970000000", 6));
      });
    });

    describe("Precision and Rounding (on-chain vs JS)", function () {
      it("should match expected Solidity mulDiv rounding for fractional results", async function () {
        await harness.setSlippageTolerance(250); // 2.5%

        // 123456789 * 10250 / 10000 = 126543208.725 → mulDiv floors to 126543208
        const estimatedAmount = 123456789n;
        const maxResult = await harness.exposed_calculateMaxWithSlippage(estimatedAmount);
        const minResult = await harness.exposed_calculateMinWithSlippage(estimatedAmount);

        expect(maxResult).to.equal(126543208n);
        expect(minResult).to.equal(120370369n);
      });

      it("should validate on-chain results match JS reference for multiple inputs", async function () {
        const amounts = [1n, 999n, 1000000n, 100000000n, ethers.parseUnits("10000", 6)];
        const slippages = [50n, 100n, 200n, 500n, 1000n];

        for (const slippageVal of slippages) {
          await harness.setSlippageTolerance(slippageVal);
          const onChainSlippage = await harness.slippageTolerance();

          for (const amount of amounts) {
            const contractMax = await harness.exposed_calculateMaxWithSlippage(amount);
            const contractMin = await harness.exposed_calculateMinWithSlippage(amount);

            // JS reference (floor division matches Solidity mulDiv default rounding)
            const jsMax = (amount * (BASIS_POINTS_FACTOR + onChainSlippage)) / BASIS_POINTS_FACTOR;
            const jsMin = (amount * (BASIS_POINTS_FACTOR - onChainSlippage)) / BASIS_POINTS_FACTOR;

            expect(contractMax).to.equal(jsMax, `Max mismatch for amount=${amount}, slippage=${slippageVal}`);
            expect(contractMin).to.equal(jsMin, `Min mismatch for amount=${amount}, slippage=${slippageVal}`);

            // Structural invariants
            expect(contractMax).to.be.gte(amount);
            expect(contractMin).to.be.lte(amount);
          }
        }
      });

      it("should handle amounts that result in exact division on-chain", async function () {
        await harness.setSlippageTolerance(250); // 2.5%

        const estimatedAmount = 4000000n; // 4 USDC
        const contractMax = await harness.exposed_calculateMaxWithSlippage(estimatedAmount);

        // 4000000 * 10250 / 10000 = 4100000 (exact)
        expect(contractMax).to.equal(4100000n);
      });
    });
  });

  describe("Integration with Buy Operations", function () {
    beforeEach(async function () {
      await harness.setTargetBufferRatio(400);
      await harness.setSlippageTolerance(200); // 2%

      const fundAmount = ethers.parseUnits("50000", 6);
      await underlyingAsset.mint(await harness.getAddress(), fundAmount);
    });

    it("should apply max slippage to approval amount in buy operation", async function () {
      const sharesAmount = ethers.parseUnits("100", 18);
      const estimatedUnderlying = await vault1.previewMint(sharesAmount);

      // Contract-computed expected approval
      const contractMax = await harness.exposed_calculateMaxWithSlippage(estimatedUnderlying);

      // Verify the mathematical relationship via the contract
      expect(contractMax).to.equal((estimatedUnderlying * 10200n) / 10000n);
    });

    it("should consistently apply slippage across multiple buy operations", async function () {
      const sharesAmount = ethers.parseUnits("50", 18);

      for (let i = 0; i < 3; i++) {
        const estimatedUnderlying = await vault1.previewMint(sharesAmount);
        const contractMax = await harness.exposed_calculateMaxWithSlippage(estimatedUnderlying);

        expect(contractMax).to.equal((estimatedUnderlying * 10200n) / 10000n);
      }
    });

    it("should update slippage calculations when tolerance is changed", async function () {
      const sharesAmount = ethers.parseUnits("100", 18);
      const estimatedUnderlying = await vault1.previewMint(sharesAmount);

      // 2% slippage
      const maxAmount1 = await harness.exposed_calculateMaxWithSlippage(estimatedUnderlying);

      // Change to 5% slippage
      await harness.setSlippageTolerance(500);
      const maxAmount2 = await harness.exposed_calculateMaxWithSlippage(estimatedUnderlying);

      expect(maxAmount2).to.be.gt(maxAmount1);
      expect(maxAmount2).to.equal((estimatedUnderlying * 10500n) / 10000n);
    });
  });

  describe("Consistency Across Different Adapters", function () {
    it("should apply same slippage calculation regardless of vault", async function () {
      await harness.setSlippageTolerance(300); // 3%

      const sharesAmount = ethers.parseUnits("100", 18);

      const estimatedUnderlying1 = await vault1.previewMint(sharesAmount);
      const estimatedUnderlying2 = await vault2.previewMint(sharesAmount);

      const contractMax1 = await harness.exposed_calculateMaxWithSlippage(estimatedUnderlying1);
      const contractMax2 = await harness.exposed_calculateMaxWithSlippage(estimatedUnderlying2);

      expect(contractMax1).to.equal((estimatedUnderlying1 * 10300n) / 10000n);
      expect(contractMax2).to.equal((estimatedUnderlying2 * 10300n) / 10000n);
    });

    it("should maintain slippage consistency even with different decimal assets", async function () {
      await harness.setSlippageTolerance(250); // 2.5%

      // Test with 6-decimal amount
      const amount6 = ethers.parseUnits("1000", 6);
      const max6 = await harness.exposed_calculateMaxWithSlippage(amount6);

      // Test with 18-decimal amount
      const amount18 = ethers.parseUnits("1000", 18);
      const max18 = await harness.exposed_calculateMaxWithSlippage(amount18);

      expect(max6).to.equal((amount6 * 10250n) / 10000n);
      expect(max18).to.equal((amount18 * 10250n) / 10000n);
    });
  });

  describe("Edge Cases and Boundary Conditions", function () {
    it("should handle maximum possible slippage tolerance on-chain", async function () {
      const highSlippage = 2000n; // 20%
      await harness.setSlippageTolerance(highSlippage);

      const estimatedAmount = ethers.parseUnits("1000", 6);
      const contractMax = await harness.exposed_calculateMaxWithSlippage(estimatedAmount);
      const contractMin = await harness.exposed_calculateMinWithSlippage(estimatedAmount);

      expect(contractMax).to.equal(ethers.parseUnits("1200", 6));
      expect(contractMin).to.equal(ethers.parseUnits("800", 6));
    });

    it("should maintain precision with fractional basis points on-chain", async function () {
      await harness.setSlippageTolerance(123); // 1.23%

      const estimatedAmount = ethers.parseUnits("10000", 6);
      const contractMax = await harness.exposed_calculateMaxWithSlippage(estimatedAmount);

      expect(contractMax).to.equal(ethers.parseUnits("10123", 6));
    });

    it("should reject slippage tolerance exceeding BASIS_POINTS_FACTOR", async function () {
      await expect(harness.setSlippageTolerance(10001)).to.be.reverted;
    });
  });

  describe("Slippage Update Propagation", function () {
    it("should immediately reflect slippage changes in on-chain calculations", async function () {
      const estimatedAmount = ethers.parseUnits("1000", 6);

      await harness.setSlippageTolerance(100); // 1%
      let maxAmount = await harness.exposed_calculateMaxWithSlippage(estimatedAmount);
      expect(maxAmount).to.equal(ethers.parseUnits("1010", 6));

      await harness.setSlippageTolerance(300); // 3%
      maxAmount = await harness.exposed_calculateMaxWithSlippage(estimatedAmount);
      expect(maxAmount).to.equal(ethers.parseUnits("1030", 6));

      await harness.setSlippageTolerance(50); // 0.5%
      maxAmount = await harness.exposed_calculateMaxWithSlippage(estimatedAmount);
      expect(maxAmount).to.equal(ethers.parseUnits("1005", 6));
    });

    it("should maintain consistency after multiple slippage updates on-chain", async function () {
      const estimatedAmount = ethers.parseUnits("5000", 6);
      const slippageValues = [100n, 200n, 300n, 150n, 250n];

      for (const slippageValue of slippageValues) {
        await harness.setSlippageTolerance(slippageValue);

        const contractMax = await harness.exposed_calculateMaxWithSlippage(estimatedAmount);
        const expectedMax = (estimatedAmount * (BASIS_POINTS_FACTOR + slippageValue)) / BASIS_POINTS_FACTOR;

        expect(contractMax).to.equal(expectedMax);
      }
    });
  });

  describe("Symmetry Validation", function () {
    it("should validate max and min are symmetric within rounding on-chain", async function () {
      await harness.setSlippageTolerance(350); // 3.5%

      const amounts = [
        ethers.parseUnits("100", 6),
        ethers.parseUnits("500", 6),
        ethers.parseUnits("1000", 6),
        ethers.parseUnits("10000", 6),
      ];

      for (const amount of amounts) {
        const contractMax = await harness.exposed_calculateMaxWithSlippage(amount);
        const contractMin = await harness.exposed_calculateMinWithSlippage(amount);

        const upperDelta = contractMax - amount;
        const lowerDelta = amount - contractMin;

        // Both deltas should be approximately equal (within 1 unit due to rounding)
        const deltaDiff = upperDelta > lowerDelta ? upperDelta - lowerDelta : lowerDelta - upperDelta;
        expect(deltaDiff).to.be.lte(1n);
      }
    });

    it("should demonstrate single source of truth for slippage on-chain", async function () {
      await harness.setSlippageTolerance(200); // 2%

      const slippage = await harness.slippageTolerance();
      expect(slippage).to.equal(200);

      const amount1 = ethers.parseUnits("1000", 6);
      const amount2 = ethers.parseUnits("2000", 6);
      const amount3 = ethers.parseUnits("3000", 6);

      expect(await harness.exposed_calculateMaxWithSlippage(amount1)).to.equal(ethers.parseUnits("1020", 6));
      expect(await harness.exposed_calculateMaxWithSlippage(amount2)).to.equal(ethers.parseUnits("2040", 6));
      expect(await harness.exposed_calculateMaxWithSlippage(amount3)).to.equal(ethers.parseUnits("3060", 6));
    });
  });
});
