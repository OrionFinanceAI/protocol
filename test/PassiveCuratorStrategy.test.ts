import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import "@openzeppelin/hardhat-upgrades";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";

import {
  MockUnderlyingAsset,
  MockERC4626Asset,
  OrionAssetERC4626ExecutionAdapter,
  OrionConfig,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  OrionTransparentVault,
  OrionAssetERC4626PriceAdapter,
  KBestTvlWeightedAverage,
  KBestTvlWeightedAverageInvalid,
} from "../typechain-types";

describe("Passive Strategist", function () {
  let transparentVaultFactory: TransparentVaultFactory;
  let orionConfig: OrionConfig;
  let underlyingAsset: MockUnderlyingAsset;
  let mockAsset1: MockERC4626Asset;
  let mockAsset2: MockERC4626Asset;
  let mockAsset3: MockERC4626Asset;
  let mockAsset4: MockERC4626Asset;
  let orionPriceAdapter: OrionAssetERC4626PriceAdapter;
  let orionExecutionAdapter: OrionAssetERC4626ExecutionAdapter;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let transparentVault: OrionTransparentVault;
  let passiveStrategist: KBestTvlWeightedAverage;

  let owner: SignerWithAddress;
  let strategist: SignerWithAddress;
  let automationRegistry: SignerWithAddress;
  let user: SignerWithAddress;

  beforeEach(async function () {
    [owner, strategist, automationRegistry, user] = await ethers.getSigners();

    // Deploy Mock Underlying Asset first (will be passed to helper)
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAssetDeployed = await MockUnderlyingAssetFactory.deploy(12);
    await underlyingAssetDeployed.waitForDeployment();
    underlyingAsset = underlyingAssetDeployed as unknown as MockUnderlyingAsset;

    // Deploy Mock ERC4626 Assets with different initial TVLs
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

    const mockAsset3Deployed = await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Mock Asset 3",
      "MA3",
    );
    await mockAsset3Deployed.waitForDeployment();
    mockAsset3 = mockAsset3Deployed as unknown as MockERC4626Asset;

    const mockAsset4Deployed = await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Mock Asset 4",
      "MA4",
    );
    await mockAsset4Deployed.waitForDeployment();
    mockAsset4 = mockAsset4Deployed as unknown as MockERC4626Asset;

    // Initialize mock assets with different amounts of underlying assets
    const initialDeposit1 = ethers.parseUnits("3000", 12);
    const initialDeposit2 = ethers.parseUnits("2000", 12);
    const initialDeposit3 = ethers.parseUnits("1500", 12);
    const initialDeposit4 = ethers.parseUnits("1000", 12);

    // Mint underlying assets to user for deposits
    await underlyingAsset.mint(user.address, ethers.parseUnits("10000", 12));

    // Deposit to all mock assets
    await underlyingAsset.connect(user).approve(await mockAsset1.getAddress(), initialDeposit1);
    await mockAsset1.connect(user).deposit(initialDeposit1, user.address);

    await underlyingAsset.connect(user).approve(await mockAsset2.getAddress(), initialDeposit2);
    await mockAsset2.connect(user).deposit(initialDeposit2, user.address);

    await underlyingAsset.connect(user).approve(await mockAsset3.getAddress(), initialDeposit3);
    await mockAsset3.connect(user).deposit(initialDeposit3, user.address);

    await underlyingAsset.connect(user).approve(await mockAsset4.getAddress(), initialDeposit4);
    await mockAsset4.connect(user).deposit(initialDeposit4, user.address);

    const deployed = await deployUpgradeableProtocol(owner, underlyingAsset, automationRegistry);

    orionConfig = deployed.orionConfig;
    liquidityOrchestrator = deployed.liquidityOrchestrator;
    transparentVaultFactory = deployed.transparentVaultFactory;

    // Deploy OrionAssetERC4626PriceAdapter
    const OrionAssetERC4626PriceAdapterFactory = await ethers.getContractFactory("OrionAssetERC4626PriceAdapter");
    orionPriceAdapter = (await OrionAssetERC4626PriceAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as OrionAssetERC4626PriceAdapter;
    await orionPriceAdapter.waitForDeployment();

    // Configure protocol
    await orionConfig.connect(owner).updateProtocolFees(10, 1000);
    await liquidityOrchestrator.setTargetBufferRatio(100); // 1% target buffer ratio

    const OrionAssetERC4626ExecutionAdapterFactory = await ethers.getContractFactory(
      "OrionAssetERC4626ExecutionAdapter",
    );
    orionExecutionAdapter = (await OrionAssetERC4626ExecutionAdapterFactory.deploy(
      await orionConfig.getAddress(),
    )) as unknown as OrionAssetERC4626ExecutionAdapter;
    await orionExecutionAdapter.waitForDeployment();

    await orionConfig.addWhitelistedAsset(
      await mockAsset1.getAddress(),
      await orionPriceAdapter.getAddress(),
      await orionExecutionAdapter.getAddress(),
    );
    await orionConfig.addWhitelistedAsset(
      await mockAsset2.getAddress(),
      await orionPriceAdapter.getAddress(),
      await orionExecutionAdapter.getAddress(),
    );
    await orionConfig.addWhitelistedAsset(
      await mockAsset3.getAddress(),
      await orionPriceAdapter.getAddress(),
      await orionExecutionAdapter.getAddress(),
    );
    await orionConfig.addWhitelistedAsset(
      await mockAsset4.getAddress(),
      await orionPriceAdapter.getAddress(),
      await orionExecutionAdapter.getAddress(),
    );

    const KBestTvlWeightedAverageFactory = await ethers.getContractFactory("KBestTvlWeightedAverage");
    const passiveStrategistDeployed = await KBestTvlWeightedAverageFactory.deploy(
      strategist.address,
      await orionConfig.getAddress(),
      3, // k = 3, select top 3 assets
    );
    await passiveStrategistDeployed.waitForDeployment();
    passiveStrategist = passiveStrategistDeployed as unknown as KBestTvlWeightedAverage;

    // Step 1: Create a transparent vault with an address (not contract) as strategist
    const tx = await transparentVaultFactory
      .connect(owner)
      .createVault(strategist.address, "Test Passive Strategist Vault", "TPSV", 0, 0, 0, ethers.ZeroAddress);
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

    transparentVault = (await ethers.getContractAt(
      "OrionTransparentVault",
      vaultAddress,
    )) as unknown as OrionTransparentVault;

    await transparentVault.connect(owner).updateFeeModel(3, 1000, 100);

    // Step 2: Update vault investment universe to exclude underlying asset
    await transparentVault
      .connect(owner)
      .updateVaultWhitelist([
        await mockAsset1.getAddress(),
        await mockAsset2.getAddress(),
        await mockAsset3.getAddress(),
        await mockAsset4.getAddress(),
      ]);

    // Step 3: Update strategist to a contract
    await transparentVault.connect(owner).updateStrategist(await passiveStrategist.getAddress());

    await passiveStrategist.connect(strategist).submitIntent(transparentVault);

    await underlyingAsset.connect(user).approve(await transparentVault.getAddress(), ethers.parseUnits("10000", 12));
    const depositAmount = ethers.parseUnits("100", 12);
    await transparentVault.connect(user).requestDeposit(depositAmount);
  });

  describe("Passive Strategist Configuration", function () {
    it("should have correct initial configuration", async function () {
      expect(await passiveStrategist.k()).to.equal(3);
      expect(await passiveStrategist.config()).to.equal(await orionConfig.getAddress());
      expect(await passiveStrategist.owner()).to.equal(strategist.address);
    });

    it("should allow owner to update k parameter", async function () {
      await passiveStrategist.connect(strategist).updateParameters(2);
      expect(await passiveStrategist.k()).to.equal(2);
    });

    it("should not allow non-owner to update k parameter", async function () {
      await expect(passiveStrategist.connect(owner).updateParameters(2)).to.be.revertedWithCustomError(
        passiveStrategist,
        "OwnableUnauthorizedAccount",
      );
    });
  });

  describe("Passive Strategist Intent Computation", function () {
    it("should compute intent with correct asset selection", async function () {
      // Get vault whitelist
      const vaultWhitelist = await transparentVault.vaultWhitelist();
      expect(vaultWhitelist.length).to.equal(5);

      // Get intent through the vault
      const [tokens, weights] = await transparentVault.getIntent();

      // Should select top 3 assets (k=3)
      expect(tokens.length).to.equal(3);
      expect(weights.length).to.equal(3);

      // Verify that the selected assets are the top 3 by TVL
      // mockAsset1: 3000, mockAsset2: 2000, mockAsset3: 1500, mockAsset4: 1000, underlyingAsset: 0
      // So top 3 should be mockAsset1, mockAsset2, mockAsset3
      expect(tokens).to.include(await mockAsset1.getAddress());
      expect(tokens).to.include(await mockAsset2.getAddress());
      expect(tokens).to.include(await mockAsset3.getAddress());
      expect(tokens).to.not.include(await mockAsset4.getAddress());
      expect(tokens).to.not.include(await underlyingAsset.getAddress());
    });

    it("should compute intent with correct weight distribution", async function () {
      const [_tokens, weights] = await transparentVault.getIntent();

      // Calculate total weight
      let totalWeight = 0n;
      for (const weight of weights) {
        totalWeight += BigInt(weight);
      }

      // Total weight should equal 10^strategistIntentDecimals
      const strategistIntentDecimals = await orionConfig.strategistIntentDecimals();
      const expectedTotalWeight = 10 ** Number(strategistIntentDecimals);
      expect(totalWeight).to.equal(expectedTotalWeight);
    });

    it("should handle case when k > number of available assets", async function () {
      // Update passive strategist to select 6 assets, but only 5 are available
      await passiveStrategist.connect(strategist).updateParameters(6);
      await passiveStrategist.connect(strategist).submitIntent(transparentVault);

      const [tokens, weights] = await transparentVault.getIntent();

      // Should select all available assets
      expect(tokens.length).to.equal(5);
      expect(weights.length).to.equal(5);

      // Verify all assets are selected
      expect(tokens).to.include(await mockAsset1.getAddress());
      expect(tokens).to.include(await mockAsset2.getAddress());
      expect(tokens).to.include(await mockAsset3.getAddress());
      expect(tokens).to.include(await mockAsset4.getAddress());
      expect(tokens).to.include(await underlyingAsset.getAddress());
    });

    it("should handle case when k = 1", async function () {
      // Update passive strategist to select only 1 asset
      await passiveStrategist.connect(strategist).updateParameters(1);
      await passiveStrategist.connect(strategist).submitIntent(transparentVault);

      const [tokens, weights] = await transparentVault.getIntent();

      // Should select only 1 asset (the one with highest TVL)
      expect(tokens.length).to.equal(1);
      expect(weights.length).to.equal(1);
      expect(tokens[0]).to.equal(await mockAsset1.getAddress()); // Highest TVL

      // Get the expected total weight based on strategist intent decimals
      const strategistIntentDecimals = await orionConfig.strategistIntentDecimals();
      const expectedTotalWeight = 10 ** Number(strategistIntentDecimals);
      expect(weights[0]).to.equal(expectedTotalWeight); // 100% allocation
    });

    it("should handle case when k = 0", async function () {
      // Update passive strategist to select 0 assets
      await passiveStrategist.connect(strategist).updateParameters(0);

      await expect(passiveStrategist.connect(strategist).submitIntent(transparentVault)).to.be.revertedWithCustomError(
        passiveStrategist,
        "OrderIntentCannotBeEmpty",
      );
    });
  });

  describe("Vault Integration with Passive Strategist", function () {
    it("should get intent from passive strategist during orchestrator execution", async function () {
      // TODO: use helper function to process full epoch, taking
      // zkVM orchestrator fixture as input.

      // Fast forward time to trigger upkeep
      const epochDuration = await liquidityOrchestrator.epochDuration();
      await time.increase(epochDuration + 1n);

      // Start the upkeep cycle
      let [_upkeepNeeded, performData] = await liquidityOrchestrator.checkUpkeep("0x");
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await liquidityOrchestrator.currentPhase()).to.equal(1); // PreprocessingTransparentVaults

      // Continue with buffering
      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await InternalStateOrchestrator.currentPhase()).to.equal(2); // Buffering

      // Continue with postprocessing
      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await InternalStateOrchestrator.currentPhase()).to.equal(3); // PostprocessingTransparentVaults

      // This is where the vault's getIntent() is called.
      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await InternalStateOrchestrator.currentPhase()).to.equal(4); // BuildingOrders

      // Complete the cycle
      [_upkeepNeeded, performData] = await InternalStateOrchestrator.checkUpkeep("0x");
      await InternalStateOrchestrator.connect(automationRegistry).performUpkeep(performData);
      expect(await InternalStateOrchestrator.currentPhase()).to.equal(0); // Back to Idle

      // Verify that orders were built based on the passive strategist's intent

      const [_sellingTokens, _sellingAmounts, _sellingEstimatedUnderlyingAmounts] =
        await InternalStateOrchestrator.getOrders(true);

      const [buyingTokens, _buyingAmounts, _buyingEstimatedUnderlyingAmounts] =
        await InternalStateOrchestrator.getOrders(false);

      // Should have buying orders for the assets selected by the passive strategist
      expect(buyingTokens.length).to.be.greaterThan(0);
      expect(buyingTokens.length).to.be.lessThanOrEqual(3); // Passive strategist selects top 3 assets

      // Verify that the selected assets are in the buying orders
      const selectedAssets = [
        await mockAsset1.getAddress(),
        await mockAsset2.getAddress(),
        await mockAsset3.getAddress(),
      ];
      for (const token of buyingTokens) {
        expect(selectedAssets).to.include(token);
      }
    });
  });

  describe("Passive Strategist Parameter Updates", function () {
    it("should reflect parameter changes in intent computation", async function () {
      // Test with k=2
      await passiveStrategist.connect(strategist).updateParameters(2);
      await passiveStrategist.connect(strategist).submitIntent(transparentVault);

      let [tokens, _weights] = await transparentVault.getIntent();
      expect(tokens.length).to.equal(2);

      // Test with k=4 (all assets)
      await passiveStrategist.connect(strategist).updateParameters(4);
      await passiveStrategist.connect(strategist).submitIntent(transparentVault);

      [tokens, _weights] = await transparentVault.getIntent();
      expect(tokens.length).to.equal(4);

      // Test with k=1
      await passiveStrategist.connect(strategist).updateParameters(1);
      await passiveStrategist.connect(strategist).submitIntent(transparentVault);

      [tokens, _weights] = await transparentVault.getIntent();
      expect(tokens.length).to.equal(1);
    });
  });

  describe("Vault Whitelist Updates with Passive Strategist Validation", function () {
    it("should validate passive strategist when updating vault whitelist", async function () {
      await transparentVault
        .connect(owner)
        .updateVaultWhitelist([await mockAsset1.getAddress(), await mockAsset2.getAddress()]);

      const whitelist = await transparentVault.vaultWhitelist();
      expect(whitelist.length).to.equal(3);
      expect(whitelist).to.include(await mockAsset1.getAddress());
      expect(whitelist).to.include(await mockAsset2.getAddress());
    });

    it("should allow whitelist updates when strategist is not a passive strategist", async function () {
      await transparentVault.connect(owner).updateStrategist(owner.address);

      await transparentVault
        .connect(owner)
        .updateVaultWhitelist([await mockAsset1.getAddress(), await mockAsset2.getAddress()]);

      await transparentVault.connect(owner).updateStrategist(await passiveStrategist.getAddress());
    });
  });

  describe("Error Handling", function () {
    it("should maintain valid intent weights after parameter changes", async function () {
      // Test various k values to ensure weights always sum to 100%
      for (let k = 1; k <= 4; k++) {
        await passiveStrategist.connect(strategist).updateParameters(k);
        const [_tokens, weights] = await transparentVault.getIntent();

        let totalWeight = 0n;
        for (const weight of weights) {
          totalWeight += BigInt(weight);
        }

        // Get the expected total weight based on strategist intent decimals
        const strategistIntentDecimals = await orionConfig.strategistIntentDecimals();
        const expectedTotalWeight = 10 ** Number(strategistIntentDecimals);
        expect(totalWeight).to.equal(expectedTotalWeight); // 100%
      }
    });

    it("should fail when passive strategist does not adjust weights to sum to intentScale", async function () {
      // Deploy the invalid passive strategist contract (without weight adjustment logic)
      const KBestTvlWeightedAverageInvalidFactory = await ethers.getContractFactory("KBestTvlWeightedAverageInvalid");
      const invalidStrategistDeployed = await KBestTvlWeightedAverageInvalidFactory.deploy(
        strategist.address,
        await orionConfig.getAddress(),
        3, // k = 3, select top 3 assets
      );
      await invalidStrategistDeployed.waitForDeployment();
      const invalidStrategist = invalidStrategistDeployed as unknown as KBestTvlWeightedAverageInvalid;

      // Create a new vault for this test
      const tx = await transparentVaultFactory
        .connect(owner)
        .createVault(strategist.address, "Invalid Passive Strategist Vault", "IPSV", 0, 0, 0, ethers.ZeroAddress);
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

      const invalidVault = (await ethers.getContractAt(
        "OrionTransparentVault",
        vaultAddress,
      )) as unknown as OrionTransparentVault;

      await invalidVault.connect(owner).updateFeeModel(3, 1000, 100);

      // Update vault investment universe
      await invalidVault
        .connect(owner)
        .updateVaultWhitelist([
          await mockAsset1.getAddress(),
          await mockAsset2.getAddress(),
          await mockAsset3.getAddress(),
          await mockAsset4.getAddress(),
        ]);

      // Associate the invalid passive strategist with the vault
      await invalidVault.connect(owner).updateStrategist(await invalidStrategist.getAddress());

      // Attempt to submit intent - this should fail because weights don't sum to intentScale
      await expect(invalidStrategist.connect(strategist).submitIntent(invalidVault)).to.be.revertedWithCustomError(
        invalidVault,
        "InvalidTotalWeight",
      );
    });
  });
});
