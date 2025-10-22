import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import {
  MockUnderlyingAsset,
  MockERC4626Asset,
  MockPriceAdapter,
  MockExecutionAdapter,
  OrionConfig,
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  OrionTransparentVault,
  PriceAdapterRegistry,
} from "../typechain-types";

let transparentVaultFactory: TransparentVaultFactory;
let orionConfig: OrionConfig;
let underlyingAsset: MockUnderlyingAsset;
let mockAsset1: MockERC4626Asset;
let mockAsset2: MockERC4626Asset;
let mockPriceAdapter1: MockPriceAdapter;
let mockPriceAdapter2: MockPriceAdapter;
let mockExecutionAdapter1: MockExecutionAdapter;
let mockExecutionAdapter2: MockExecutionAdapter;
let priceAdapterRegistry: PriceAdapterRegistry;
let internalStatesOrchestrator: InternalStatesOrchestrator;
let liquidityOrchestrator: LiquidityOrchestrator;
let transparentVault: OrionTransparentVault;

let owner: SignerWithAddress, curator: SignerWithAddress, other: SignerWithAddress;

beforeEach(async function () {
  [owner, curator, other] = await ethers.getSigners();

  const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
  const underlyingAssetDeployed = await MockUnderlyingAssetFactory.deploy(6);
  await underlyingAssetDeployed.waitForDeployment();
  underlyingAsset = underlyingAssetDeployed as unknown as MockUnderlyingAsset;

  const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
  const mockAsset1Deployed = await MockERC4626AssetFactory.deploy(
    await underlyingAsset.getAddress(),
    "Mock Asset 1",
    "MA1",
  );
  await mockAsset1Deployed.waitForDeployment();
  mockAsset1 = mockAsset1Deployed as unknown as MockERC4626Asset;

  const mockAsset2Deployed = await MockERC4626AssetFactory.deploy(
    await underlyingAsset.getAddress(),
    "Mock Asset 2",
    "MA2",
  );
  await mockAsset2Deployed.waitForDeployment();
  mockAsset2 = mockAsset2Deployed as unknown as MockERC4626Asset;

  // Deploy OrionConfig
  const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
  const orionConfigDeployed = await OrionConfigFactory.deploy(owner.address, await underlyingAsset.getAddress());
  await orionConfigDeployed.waitForDeployment();
  orionConfig = orionConfigDeployed as unknown as OrionConfig;

  const TransparentVaultFactoryFactory = await ethers.getContractFactory("TransparentVaultFactory");
  const transparentVaultFactoryDeployed = await TransparentVaultFactoryFactory.deploy(await orionConfig.getAddress());
  await transparentVaultFactoryDeployed.waitForDeployment();
  transparentVaultFactory = transparentVaultFactoryDeployed as unknown as TransparentVaultFactory;

  const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
  const internalStatesOrchestratorDeployed = await InternalStatesOrchestratorFactory.deploy(
    owner.address,
    await orionConfig.getAddress(),
    await other.address,
  );
  await internalStatesOrchestratorDeployed.waitForDeployment();
  internalStatesOrchestrator = internalStatesOrchestratorDeployed as unknown as InternalStatesOrchestrator;

  const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
  const liquidityOrchestratorDeployed = await LiquidityOrchestratorFactory.deploy(
    owner.address,
    await orionConfig.getAddress(),
    await other.address,
  );
  await liquidityOrchestratorDeployed.waitForDeployment();
  liquidityOrchestrator = liquidityOrchestratorDeployed as unknown as LiquidityOrchestrator;

  const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
  mockPriceAdapter1 = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
  await mockPriceAdapter1.waitForDeployment();

  mockPriceAdapter2 = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
  await mockPriceAdapter2.waitForDeployment();

  const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
  mockExecutionAdapter1 = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
  await mockExecutionAdapter1.waitForDeployment();

  mockExecutionAdapter2 = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
  await mockExecutionAdapter2.waitForDeployment();

  const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
  const priceAdapterRegistryDeployed = await PriceAdapterRegistryFactory.deploy(
    owner.address,
    await orionConfig.getAddress(),
  );
  await priceAdapterRegistryDeployed.waitForDeployment();
  priceAdapterRegistry = priceAdapterRegistryDeployed as unknown as PriceAdapterRegistry;

  await orionConfig.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());
  await orionConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());
  await orionConfig.setVaultFactory(await transparentVaultFactory.getAddress());
  await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());
  await orionConfig.setProtocolRiskFreeRate(0.0423 * 10_000);

  await orionConfig.addWhitelistedAsset(
    await mockAsset1.getAddress(),
    await mockPriceAdapter1.getAddress(),
    await mockExecutionAdapter1.getAddress(),
  );
  await orionConfig.addWhitelistedAsset(
    await mockAsset2.getAddress(),
    await mockPriceAdapter2.getAddress(),
    await mockExecutionAdapter2.getAddress(),
  );
});

describe("TransparentVault - Curator Pipeline", function () {
  describe("Vault Creation", function () {
    it("Should create a transparent vault with correct parameters", async function () {
      const tx = await transparentVaultFactory.connect(owner).createVault(curator.address, "Test Vault", "TV", 0, 0, 0);
      const receipt = await tx.wait();

      // Find the vault creation event
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = transparentVaultFactory.interface.parseLog(log);
          return parsed?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });

      void expect(event).to.not.be.undefined;
      const parsedEvent = transparentVaultFactory.interface.parseLog(event!);
      const vaultAddress = parsedEvent?.args[0];

      void expect(vaultAddress).to.not.equal(ethers.ZeroAddress);

      // Get the vault contract
      transparentVault = (await ethers.getContractAt(
        "OrionTransparentVault",
        vaultAddress,
      )) as unknown as OrionTransparentVault;

      // Verify vault properties
      void expect(await transparentVault.vaultOwner()).to.equal(owner.address);
      void expect(await transparentVault.curator()).to.equal(curator.address);
      void expect(await transparentVault.config()).to.equal(await orionConfig.getAddress());
    });
  });

  describe("Curator Operations", function () {
    beforeEach(async function () {
      // Create a vault first
      const tx = await transparentVaultFactory.connect(owner).createVault(curator.address, "Test Vault", "TV", 0, 0, 0);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = transparentVaultFactory.interface.parseLog(log);
          return parsed?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      const parsedEvent = transparentVaultFactory.interface.parseLog(event!);
      const vaultAddress = parsedEvent?.args[0];
      transparentVault = (await ethers.getContractAt(
        "OrionTransparentVault",
        vaultAddress,
      )) as unknown as OrionTransparentVault;
    });

    it("Should allow vault owner to update vault whitelist", async function () {
      const newWhitelist = [await mockAsset1.getAddress(), await mockAsset2.getAddress()];

      await expect(transparentVault.connect(owner).updateVaultWhitelist(newWhitelist)).to.not.be.reverted;
    });

    it("Should allow vault owner to update fee model", async function () {
      const feeType = 0; // Performance fee mode
      const performanceFee = 2000; // 20% in basis points
      const managementFee = 100; // 1% in basis points

      await expect(transparentVault.connect(owner).updateFeeModel(feeType, performanceFee, managementFee)).to.not.be
        .reverted;
    });

    it("Should allow vault owner to claim curator fees", async function () {
      const claimAmount = ethers.parseUnits("50", 6); // Try to claim 50 USDC

      await expect(transparentVault.connect(owner).claimCuratorFees(claimAmount)).to.be.revertedWithCustomError(
        transparentVault,
        "InsufficientAmount",
      );
    });

    it("Should allow curator to submit intent", async function () {
      const whitelist = [await mockAsset1.getAddress(), await mockAsset2.getAddress()];
      await transparentVault.connect(owner).updateVaultWhitelist(whitelist);

      // Submit intent with 60% in asset1 and 40% in asset2
      const intent = [
        {
          token: await mockAsset1.getAddress(),
          weight: 600000000, // 60% * 10^9 (curator intent decimals)
        },
        {
          token: await mockAsset2.getAddress(),
          weight: 400000000, // 40% * 10^9 (curator intent decimals)
        },
      ];

      await expect(transparentVault.connect(curator).submitIntent(intent)).to.not.be.reverted;

      // Verify the intent was stored correctly
      const [tokens, weights] = await transparentVault.getIntent();
      void expect(tokens).to.deep.equal([await mockAsset1.getAddress(), await mockAsset2.getAddress()]);
      void expect(weights).to.deep.equal([600000000, 400000000]);
    });

    it("Should reject intent with invalid total weight", async function () {
      const whitelist = [await mockAsset1.getAddress(), await mockAsset2.getAddress()];
      await transparentVault.connect(owner).updateVaultWhitelist(whitelist);

      // Submit intent with total weight != 100%
      const intent = [
        {
          token: await mockAsset1.getAddress(),
          weight: 600000000, // 60%
        },
        {
          token: await mockAsset2.getAddress(),
          weight: 300000000, // 30% (total = 90%)
        },
      ];

      await expect(transparentVault.connect(curator).submitIntent(intent)).to.be.revertedWithCustomError(
        transparentVault,
        "InvalidTotalWeight",
      );
    });

    it("Should reject intent with non-whitelisted assets", async function () {
      // Create a new mock asset that's not in the protocol whitelist
      const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
      const nonWhitelistedAsset = await MockERC4626AssetFactory.deploy(
        await underlyingAsset.getAddress(),
        "Non Whitelisted Asset",
        "NWA",
      );
      await nonWhitelistedAsset.waitForDeployment();

      const intent = [
        {
          token: await nonWhitelistedAsset.getAddress(),
          weight: 1000000000, // 100%
        },
      ];

      await expect(transparentVault.connect(curator).submitIntent(intent)).to.be.revertedWithCustomError(
        transparentVault,
        "TokenNotWhitelisted",
      );
    });

    it("Should reject intent from non-curator", async function () {
      const whitelist = [await mockAsset1.getAddress(), await mockAsset2.getAddress()];
      await transparentVault.connect(owner).updateVaultWhitelist(whitelist);

      const intent = [
        {
          token: await mockAsset1.getAddress(),
          weight: 1000000000, // 100%
        },
      ];

      await expect(transparentVault.connect(other).submitIntent(intent)).to.be.revertedWithCustomError(
        transparentVault,
        "UnauthorizedAccess",
      );
    });
  });

  describe("Full Pipeline Integration", function () {
    it("Should execute complete curator pipeline successfully", async function () {
      // 1. Create vault
      const tx = await transparentVaultFactory
        .connect(owner)
        .createVault(curator.address, "Integration Test Vault", "ITV", 0, 0, 0);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = transparentVaultFactory.interface.parseLog(log);
          return parsed?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      const parsedEvent = transparentVaultFactory.interface.parseLog(event!);
      const vaultAddress = parsedEvent?.args[0];
      transparentVault = (await ethers.getContractAt(
        "OrionTransparentVault",
        vaultAddress,
      )) as unknown as OrionTransparentVault;

      // 2. Update vault whitelist
      const whitelist = [await mockAsset1.getAddress(), await mockAsset2.getAddress()];
      await transparentVault.connect(owner).updateVaultWhitelist(whitelist);

      // 3. Update fee model
      await transparentVault.connect(owner).updateFeeModel(0, 2000, 100);

      // 4. Submit intent
      const intent = [
        {
          token: await mockAsset1.getAddress(),
          weight: 700000000, // 70%
        },
        {
          token: await mockAsset2.getAddress(),
          weight: 300000000, // 30%
        },
      ];
      await transparentVault.connect(curator).submitIntent(intent);

      const [tokens, weights] = await transparentVault.getIntent();
      void expect(tokens).to.deep.equal([await mockAsset1.getAddress(), await mockAsset2.getAddress()]);
      void expect(weights).to.deep.equal([700000000, 300000000]);
    });
  });
});
