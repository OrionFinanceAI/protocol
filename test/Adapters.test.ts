import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import {
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  MockUnderlyingAsset,
  OrionAssetERC4626PriceAdapter,
  OrionConfig,
  PriceAdapterRegistry,
} from "../typechain-types";

describe("Price Adapter", function () {
  let orionConfig: OrionConfig;
  let underlyingAsset: MockUnderlyingAsset;
  let mockAsset1: MockUnderlyingAsset;
  let priceAdapter: OrionAssetERC4626PriceAdapter;
  let priceAdapterRegistry: PriceAdapterRegistry;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let internalStatesOrchestrator: InternalStatesOrchestrator;

  let owner: SignerWithAddress;
  let automationRegistry: SignerWithAddress;

  beforeEach(async function () {
    [owner, automationRegistry] = await ethers.getSigners();

    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAssetDeployed = await MockUnderlyingAssetFactory.deploy(12);
    await underlyingAssetDeployed.waitForDeployment();
    underlyingAsset = underlyingAssetDeployed as unknown as MockUnderlyingAsset;

    const MockERC20AssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const mockAsset1Deployed = await MockERC20AssetFactory.deploy(10);
    await mockAsset1Deployed.waitForDeployment();
    mockAsset1 = mockAsset1Deployed as unknown as MockUnderlyingAsset;

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
  });
});
