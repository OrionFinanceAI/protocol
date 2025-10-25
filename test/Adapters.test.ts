import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import {
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  MockERC4626Asset,
  MockUnderlyingAsset,
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
    const orionConfigDeployed = await OrionConfigFactory.deploy(owner.address, await underlyingAsset.getAddress());
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
});
