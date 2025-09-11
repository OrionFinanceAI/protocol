import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, fhevm } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import {
  MockUnderlyingAsset,
  MockERC4626Asset,
  MockPriceAdapter,
  MockExecutionAdapter,
  OrionConfig,
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  EncryptedVaultFactory,
  OrionTransparentVault,
  OrionEncryptedVault,
  PriceAdapterRegistry,
  OrionAssetERC4626PriceAdapter,
} from "../typechain-types";

describe("Orchestrators", function () {
  let transparentVaultFactory: TransparentVaultFactory;
  let encryptedVaultFactory: EncryptedVaultFactory;
  let orionConfig: OrionConfig;
  let underlyingAsset: MockUnderlyingAsset;
  let mockAsset1: MockERC4626Asset;
  let mockAsset2: MockERC4626Asset;
  let mockAsset3: MockERC4626Asset;
  let mockPriceAdapter1: MockPriceAdapter;
  let orionPriceAdapter1: OrionAssetERC4626PriceAdapter;
  let orionPriceAdapter2: OrionAssetERC4626PriceAdapter;
  let mockExecutionAdapter1: MockExecutionAdapter;
  let mockExecutionAdapter2: MockExecutionAdapter;
  let mockExecutionAdapter3: MockExecutionAdapter;
  let priceAdapterRegistry: PriceAdapterRegistry;
  let internalStatesOrchestrator: InternalStatesOrchestrator;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let transparentVault: OrionTransparentVault;
  let encryptedVault: OrionEncryptedVault;

  let owner: SignerWithAddress;
  let curator: SignerWithAddress;
  let automationRegistry: SignerWithAddress;
  let user: SignerWithAddress;

  beforeEach(async function () {
    [owner, curator, automationRegistry, user] = await ethers.getSigners();

    // Deploy Mock Underlying Asset
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAssetDeployed = await MockUnderlyingAssetFactory.deploy(6);
    await underlyingAssetDeployed.waitForDeployment();
    underlyingAsset = underlyingAssetDeployed as unknown as MockUnderlyingAsset;

    // Deploy Mock ERC4626 Assets
    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    const mockAsset1Deployed = await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Mock Asset 1",
      "MA1",
      10,
    );
    await mockAsset1Deployed.waitForDeployment();
    mockAsset1 = mockAsset1Deployed as unknown as MockERC4626Asset;

    const mockAsset2Deployed = await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Mock Asset 2",
      "MA2",
      18,
    );
    await mockAsset2Deployed.waitForDeployment();
    mockAsset2 = mockAsset2Deployed as unknown as MockERC4626Asset;

    const mockAsset3Deployed = await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Mock Asset 3",
      "MA3",
      18,
    );
    await mockAsset3Deployed.waitForDeployment();
    mockAsset3 = mockAsset3Deployed as unknown as MockERC4626Asset;

    // Deploy OrionConfig
    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    const orionConfigDeployed = await OrionConfigFactory.deploy(owner.address, await underlyingAsset.getAddress());
    await orionConfigDeployed.waitForDeployment();
    orionConfig = orionConfigDeployed as unknown as OrionConfig;

    // Deploy Price Adapter Registry
    const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
    const priceAdapterRegistryDeployed = await PriceAdapterRegistryFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
    );
    await priceAdapterRegistryDeployed.waitForDeployment();
    priceAdapterRegistry = priceAdapterRegistryDeployed as unknown as PriceAdapterRegistry;

    // Deploy Mock Price Adapters
    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    mockPriceAdapter1 = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
    await mockPriceAdapter1.waitForDeployment();

    // Deploy OrionAssetERC4626PriceAdapter instances
    const OrionAssetERC4626PriceAdapterFactory = await ethers.getContractFactory("OrionAssetERC4626PriceAdapter");
    orionPriceAdapter1 = (await OrionAssetERC4626PriceAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as OrionAssetERC4626PriceAdapter;
    await orionPriceAdapter1.waitForDeployment();

    orionPriceAdapter2 = (await OrionAssetERC4626PriceAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as OrionAssetERC4626PriceAdapter;
    await orionPriceAdapter2.waitForDeployment();

    // Deploy Mock Execution Adapters
    const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
    mockExecutionAdapter1 = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
    await mockExecutionAdapter1.waitForDeployment();

    mockExecutionAdapter2 = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
    await mockExecutionAdapter2.waitForDeployment();

    mockExecutionAdapter3 = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
    await mockExecutionAdapter3.waitForDeployment();

    // Deploy TransparentVaultFactory
    const TransparentVaultFactoryFactory = await ethers.getContractFactory("TransparentVaultFactory");
    const transparentVaultFactoryDeployed = await TransparentVaultFactoryFactory.deploy(await orionConfig.getAddress());
    await transparentVaultFactoryDeployed.waitForDeployment();
    transparentVaultFactory = transparentVaultFactoryDeployed as unknown as TransparentVaultFactory;

    // Deploy EncryptedVaultFactory
    const EncryptedVaultFactoryFactory = await ethers.getContractFactory("EncryptedVaultFactory");
    const encryptedVaultFactoryDeployed = await EncryptedVaultFactoryFactory.deploy(await orionConfig.getAddress());
    await encryptedVaultFactoryDeployed.waitForDeployment();
    encryptedVaultFactory = encryptedVaultFactoryDeployed as unknown as EncryptedVaultFactory;

    // Deploy LiquidityOrchestrator first
    const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
    const liquidityOrchestratorDeployed = await LiquidityOrchestratorFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
      automationRegistry.address,
    );
    await liquidityOrchestratorDeployed.waitForDeployment();
    liquidityOrchestrator = liquidityOrchestratorDeployed as unknown as LiquidityOrchestrator;

    // Set liquidity orchestrator and price adapter registry in config before deploying InternalStatesOrchestrator
    await orionConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());
    await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

    // Deploy InternalStatesOrchestrator
    const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
    const internalStatesOrchestratorDeployed = await InternalStatesOrchestratorFactory.deploy(
      owner.address,
      await orionConfig.getAddress(),
      automationRegistry.address,
    );
    await internalStatesOrchestratorDeployed.waitForDeployment();
    internalStatesOrchestrator = internalStatesOrchestratorDeployed as unknown as InternalStatesOrchestrator;

    // Configure OrionConfig
    await orionConfig.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());
    await orionConfig.setVaultFactories(
      await transparentVaultFactory.getAddress(),
      await encryptedVaultFactory.getAddress(),
    );

    // Configure LiquidityOrchestrator
    await liquidityOrchestrator.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());

    // Set slippage bound to initialize targetBufferRatio
    await liquidityOrchestrator.setSlippageBound(100); // 1% slippage bound

    // Add assets to whitelist - creating a mixed investment universe
    // Asset 1: Mock asset with MockPriceAdapter
    await orionConfig.addWhitelistedAsset(
      await mockAsset1.getAddress(),
      await mockPriceAdapter1.getAddress(),
      await mockExecutionAdapter1.getAddress(),
    );
    // Asset 2: Mock asset with OrionAssetERC4626PriceAdapter
    await orionConfig.addWhitelistedAsset(
      await mockAsset2.getAddress(),
      await orionPriceAdapter1.getAddress(),
      await mockExecutionAdapter2.getAddress(),
    );
    // Asset 3: Mock asset with OrionAssetERC4626PriceAdapter
    await orionConfig.addWhitelistedAsset(
      await mockAsset3.getAddress(),
      await orionPriceAdapter2.getAddress(),
      await mockExecutionAdapter3.getAddress(),
    );

    // Create a transparent vault
    const tx = await transparentVaultFactory
      .connect(owner)
      .createVault(curator.address, "Test Transparent Vault", "TTV", 0, 0, 0);
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

    // Submit a plaintext intent to the vault with mixed price adapters
    const intent = [
      {
        token: await mockAsset1.getAddress(),
        value: 400000000, // 40% (40% of 1e9)
      },
      {
        token: await mockAsset2.getAddress(),
        value: 350000000, // 35% (35% of 1e9)
      },
      {
        token: await mockAsset3.getAddress(),
        value: 250000000, // 25% (25% of 1e9)
      },
    ];
    await transparentVault.connect(curator).submitIntent(intent);

    // Mint underlying assets to the user and make a deposit request
    await underlyingAsset.mint(user.address, ethers.parseUnits("10000", 6));
    await underlyingAsset.connect(user).approve(await transparentVault.getAddress(), ethers.parseUnits("10000", 6));
    const depositAmount = ethers.parseUnits("100", 6);
    await transparentVault.connect(user).requestDeposit(depositAmount);

    // Create an encrypted vault
    const tx2 = await encryptedVaultFactory
      .connect(owner)
      .createVault(curator.address, "Test Encrypted Vault", "TEV", 0, 0, 0);
    const receipt2 = await tx2.wait();

    // Find the vault creation event
    const event2 = receipt2?.logs.find((log) => {
      try {
        const parsed = encryptedVaultFactory.interface.parseLog(log);
        return parsed?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });

    void expect(event2).to.not.be.undefined;
    const parsedEvent2 = encryptedVaultFactory.interface.parseLog(event2!);
    const vaultAddress2 = parsedEvent2?.args[0];

    // Get the vault contract
    encryptedVault = (await ethers.getContractAt(
      "OrionEncryptedVault",
      vaultAddress2,
    )) as unknown as OrionEncryptedVault;

    const encryptedIntentBuffer = fhevm.createEncryptedInput(await encryptedVault.getAddress(), curator.address);

    encryptedIntentBuffer.add128(400000000); // 40% * 10^9
    encryptedIntentBuffer.add128(350000000); // 35% * 10^9
    encryptedIntentBuffer.add128(250000000); // 25% * 10^9

    const encryptedIntentCiphertexts = await encryptedIntentBuffer.encrypt();

    const encryptedIntent = [
      {
        token: await mockAsset1.getAddress(),
        weight: encryptedIntentCiphertexts.handles[0],
      },
      {
        token: await mockAsset2.getAddress(),
        weight: encryptedIntentCiphertexts.handles[1],
      },
      {
        token: await mockAsset3.getAddress(),
        weight: encryptedIntentCiphertexts.handles[2],
      },
    ];

    await encryptedVault.connect(curator).submitIntent(encryptedIntent, encryptedIntentCiphertexts.inputProof);

    await underlyingAsset.connect(user).approve(await encryptedVault.getAddress(), ethers.parseUnits("100", 6));
    await encryptedVault.connect(user).requestDeposit(depositAmount);
  });

  describe("performUpkeep", function () {
    it("should complete full upkeep cycle with intent decryption", async function () {
      // Await decryption oracle and verify intent is valid
      await fhevm.awaitDecryptionOracle();
      const isIntentValid = await encryptedVault.isIntentValid();
      void expect(isIntentValid).to.be.true;

      // Fast forward time to trigger upkeep
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Idle

      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      let [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // PreprocessingEncryptedVaults

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      await fhevm.awaitDecryptionOracle();
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(4); // Buffering

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(5); // PostprocessingTransparentVaults

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");

      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(6); // PostprocessingEncryptedVaults

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(7); // BuildingOrders

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Back to Idle
      expect(await internalStatesOrchestrator.epochCounter()).to.equal(1); // Epoch incremented

      // Check that orders were built
      const [sellingTokens] = await internalStatesOrchestrator.getSellingOrders();
      const [buyingTokens, _buyingAmounts] = await internalStatesOrchestrator.getBuyingOrders();

      // Should have all three assets in the orders arrays
      expect(sellingTokens.length).to.equal(3); // All three assets
      expect(buyingTokens.length).to.equal(3); // All three assets
    });

    it("should complete full upkeep cycles without intent decryption", async function () {
      // Skip intent decryption - don't await decryption oracle
      // Encrypted Vault intents is invalid, so they are not processed

      // Fast forward time to trigger upkeep
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Idle

      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      let [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(2); // PreprocessingEncryptedVaults

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(4); // Buffering

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(5); // PostprocessingTransparentVaults

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");

      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(6); // PostprocessingEncryptedVaults

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(7); // BuildingOrders

      [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await internalStatesOrchestrator.currentPhase()).to.equal(0); // Back to Idle
      expect(await internalStatesOrchestrator.epochCounter()).to.equal(1); // Epoch incremented

      // Check that orders were built
      const [sellingTokens] = await internalStatesOrchestrator.getSellingOrders();
      const [buyingTokens, _buyingAmounts] = await internalStatesOrchestrator.getBuyingOrders();

      // Should have all three assets in the orders arrays
      expect(sellingTokens.length).to.equal(3); // All three assets
      expect(buyingTokens.length).to.equal(3); // All three assets

      // Now check if liquidity orchestrator needs to be triggered
      const [liquidityUpkeepNeeded, _liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.true;
    });

    it("should not trigger upkeep when system is idle and time hasn't passed", async function () {
      // Don't fast forward time, so system should be idle because time hasn't passed
      const [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      void expect(upkeepNeeded).to.be.false;
      void expect(performData).to.equal("0x");
    });

    it("should not trigger upkeep when not enough time has passed", async function () {
      // Fast forward less than epoch duration
      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration / 2n);

      const [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");

      void expect(upkeepNeeded).to.be.false;
      void expect(performData).to.equal("0x");
    });

    it("should only allow automation registry to call performUpkeep", async function () {
      // Fast forward time to trigger upkeep
      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      const [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");

      // Should fail when called by non-automation registry
      await expect(internalStatesOrchestrator.connect(owner).performUpkeep(performData)).to.be.revertedWithCustomError(
        internalStatesOrchestrator,
        "NotAuthorized",
      );

      // Should succeed when called by automation registry
      await expect(internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData)).to.not.be
        .reverted;
    });

    it("should not trigger liquidity orchestrator when epoch counter hasn't changed", async function () {
      // Initially, liquidity orchestrator should not need upkeep
      let [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.false;
      expect(liquidityPerformData).to.equal("0x");

      // Now liquidity orchestrator should not need upkeep
      [liquidityUpkeepNeeded, liquidityPerformData] = await liquidityOrchestrator.checkUpkeep("0x");
      void expect(liquidityUpkeepNeeded).to.be.false;
      expect(liquidityPerformData).to.equal("0x");
    });

    it("should only allow automation registry to call liquidity orchestrator performUpkeep", async function () {
      // Should fail when called by non-automation registry
      await expect(liquidityOrchestrator.connect(owner).performUpkeep("0x")).to.be.revertedWithCustomError(
        liquidityOrchestrator,
        "NotAuthorized",
      );
    });
  });

  describe("configuration", function () {
    it("should allow owner to update epoch duration", async function () {
      const newEpochDuration = 2 * 24 * 60 * 60; // 2 days
      await internalStatesOrchestrator.updateEpochDuration(newEpochDuration);
      expect(await internalStatesOrchestrator.epochDuration()).to.equal(newEpochDuration);
    });

    it("should allow owner to update minibatch sizes", async function () {
      await expect(internalStatesOrchestrator.updateMinibatchSizes(2, 2)).to.not.be.reverted;
    });

    it("should allow owner to update protocol fees", async function () {
      await internalStatesOrchestrator.updateProtocolFees(50, 100); // 0.5% volume fee, 1% revenue share
      expect(await internalStatesOrchestrator.vFeeCoefficient()).to.equal(50);
      expect(await internalStatesOrchestrator.rsFeeCoefficient()).to.equal(100);
    });

    it("should revert when updating protocol fees with invalid arguments", async function () {
      // Test with volume fee coefficient exceeding maximum
      await expect(internalStatesOrchestrator.updateProtocolFees(101, 100)).to.be.revertedWithCustomError(
        internalStatesOrchestrator,
        "InvalidArguments",
      );

      // Test with revenue share fee coefficient exceeding maximum
      await expect(internalStatesOrchestrator.updateProtocolFees(50, 2001)).to.be.revertedWithCustomError(
        internalStatesOrchestrator,
        "InvalidArguments",
      );

      // Test with both coefficients exceeding maximum
      await expect(internalStatesOrchestrator.updateProtocolFees(101, 2001)).to.be.revertedWithCustomError(
        internalStatesOrchestrator,
        "InvalidArguments",
      );
    });

    it("should not allow non-owner to update configuration", async function () {
      await expect(
        internalStatesOrchestrator.connect(curator).updateEpochDuration(86400),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "OwnableUnauthorizedAccount");
    });

    it("should revert when updating automation registry with zero address", async function () {
      await expect(
        internalStatesOrchestrator.updateAutomationRegistry(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "ZeroAddress");
    });

    it("should revert when updating automation registry when system is not idle", async function () {
      // Fast forward time to trigger upkeep and make system not idle
      const epochDuration = await internalStatesOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      const [_upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);

      // Now system is not idle (in PreprocessingTransparentVaults phase)
      const newAutomationRegistry = user.address;
      await expect(
        internalStatesOrchestrator.updateAutomationRegistry(newAutomationRegistry),
      ).to.be.revertedWithCustomError(internalStatesOrchestrator, "SystemNotIdle");
    });

    it("should successfully update automation registry and emit event", async function () {
      const newAutomationRegistry = user.address;

      await expect(internalStatesOrchestrator.updateAutomationRegistry(newAutomationRegistry))
        .to.emit(internalStatesOrchestrator, "AutomationRegistryUpdated")
        .withArgs(newAutomationRegistry);

      expect(await internalStatesOrchestrator.automationRegistry()).to.equal(newAutomationRegistry);
    });
  });
});
