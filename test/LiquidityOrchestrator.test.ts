import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("LiquidityOrchestrator", function () {
  // Test fixture setup
  async function deployLiquidityOrchestratorFixture() {
    const [owner, automationRegistry, vaultFactory, curator1, curator2, depositor1, depositor2, unauthorized] =
      await ethers.getSigners();

    // Deploy underlying asset (USDC-like, 6 decimals)
    const UnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAsset = await UnderlyingAssetFactory.deploy();
    await underlyingAsset.waitForDeployment();

    // Deploy ERC4626 assets
    const ERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");

    const erc4626Asset1 = await ERC4626AssetFactory.deploy(underlyingAsset, "Vault Token 1", "VT1");
    await erc4626Asset1.waitForDeployment();
    const erc4626Asset2 = await ERC4626AssetFactory.deploy(underlyingAsset, "Vault Token 2", "VT2");
    await erc4626Asset2.waitForDeployment();

    // Deploy OrionConfig
    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    const config = await OrionConfigFactory.deploy();
    await config.waitForDeployment();
    await config.initialize(owner.address);

    // Deploy OracleRegistry
    const OracleRegistryFactory = await ethers.getContractFactory("OracleRegistry");
    const oracleRegistry = await OracleRegistryFactory.deploy();
    await oracleRegistry.waitForDeployment();
    await oracleRegistry.initialize(owner.address);

    // Deploy InternalStatesOrchestrator
    const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
    const internalStatesOrchestrator = await InternalStatesOrchestratorFactory.deploy();
    await internalStatesOrchestrator.waitForDeployment();
    await internalStatesOrchestrator.initialize(owner.address, automationRegistry.address, await config.getAddress());

    // Deploy LiquidityOrchestrator
    const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
    const liquidityOrchestratorContract = await LiquidityOrchestratorFactory.deploy();
    await liquidityOrchestratorContract.waitForDeployment();

    // Set protocol parameters in OrionConfig BEFORE initializing LiquidityOrchestrator
    await config.setProtocolParams(
      await underlyingAsset.getAddress(),
      await internalStatesOrchestrator.getAddress(),
      await liquidityOrchestratorContract.getAddress(),
      6, // statesDecimals
      6, // curatorIntentDecimals
      vaultFactory.address, // factory
      await oracleRegistry.getAddress(),
    );

    // Whitelist the ERC4626 assets so they can be used in vault intents
    await config.addWhitelistedAsset(await erc4626Asset1.getAddress());
    await config.addWhitelistedAsset(await erc4626Asset2.getAddress());

    // Initialize LiquidityOrchestrator after config parameters are set
    await liquidityOrchestratorContract.initialize(
      owner.address,
      automationRegistry.address,
      await config.getAddress(),
    );

    // Deploy price adapters for oracles
    const ERC4626PriceAdapterFactory = await ethers.getContractFactory("ERC4626PriceAdapter");

    const erc4626Oracle = await ERC4626PriceAdapterFactory.deploy();
    await erc4626Oracle.waitForDeployment();
    await erc4626Oracle.initialize(owner.address);

    // Set price adapters in registry
    await oracleRegistry.setAdapter(await erc4626Asset1.getAddress(), await erc4626Oracle.getAddress());
    await oracleRegistry.setAdapter(await erc4626Asset2.getAddress(), await erc4626Oracle.getAddress());

    // Deploy execution adapter for ERC4626 assets
    const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");

    const erc4626ExecutionAdapter = await ERC4626ExecutionAdapterFactory.deploy();
    await erc4626ExecutionAdapter.waitForDeployment();
    await erc4626ExecutionAdapter.initialize(owner.address);

    // Set adapters in LiquidityOrchestrator
    await liquidityOrchestratorContract.setAdapter(
      await erc4626Asset1.getAddress(),
      await erc4626ExecutionAdapter.getAddress(),
    );
    await liquidityOrchestratorContract.setAdapter(
      await erc4626Asset2.getAddress(),
      await erc4626ExecutionAdapter.getAddress(),
    );

    // Deploy two transparent vaults
    const OrionTransparentVaultFactory = await ethers.getContractFactory("OrionTransparentVault");

    const vault1 = await OrionTransparentVaultFactory.deploy();
    await vault1.waitForDeployment();
    await vault1.initialize(curator1.address, await config.getAddress(), "Test Vault 1", "TV1");

    const vault2 = await OrionTransparentVaultFactory.deploy();
    await vault2.waitForDeployment();
    await vault2.initialize(curator2.address, await config.getAddress(), "Test Vault 2", "TV2");

    // Add vaults to config registry.
    await config.connect(vaultFactory).addOrionVault(await vault1.getAddress(), 0);
    await config.connect(vaultFactory).addOrionVault(await vault2.getAddress(), 0);

    // Mint underlying assets to depositors
    await underlyingAsset.mint(depositor1.address, ethers.parseUnits("100000", 6));
    await underlyingAsset.mint(depositor2.address, ethers.parseUnits("100000", 6));

    return {
      config,
      oracleRegistry,
      internalStatesOrchestrator,
      liquidityOrchestratorContract,
      underlyingAsset,
      erc4626Asset1,
      erc4626Asset2,
      vault1,
      vault2,
      erc4626ExecutionAdapter,
      owner,
      automationRegistry,
      vaultFactory,
      curator1,
      curator2,
      depositor1,
      depositor2,
      unauthorized,
      erc4626Oracle,
    };
  }

  describe("Initialization", function () {
    it("Should initialize with correct parameters", async function () {
      const { liquidityOrchestratorContract, automationRegistry, config, internalStatesOrchestrator, owner } =
        await loadFixture(deployLiquidityOrchestratorFixture);

      expect(await liquidityOrchestratorContract.owner()).to.equal(owner.address);
      expect(await liquidityOrchestratorContract.automationRegistry()).to.equal(automationRegistry.address);
      expect(await liquidityOrchestratorContract.config()).to.equal(await config.getAddress());
      expect(await liquidityOrchestratorContract.internalStatesOrchestrator()).to.equal(
        await internalStatesOrchestrator.getAddress(),
      );
      expect(await liquidityOrchestratorContract.lastProcessedEpoch()).to.equal(0);
    });

    it("Should revert if initialized with zero automation registry", async function () {
      const { config, owner } = await loadFixture(deployLiquidityOrchestratorFixture);
      const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
      const liquidityOrchestrator = await LiquidityOrchestratorFactory.deploy();
      await liquidityOrchestrator.waitForDeployment();

      await expect(
        liquidityOrchestrator.initialize(owner.address, ethers.ZeroAddress, await config.getAddress()),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "ZeroAddress");
    });

    it("Should revert if initialized with zero config", async function () {
      const { automationRegistry, owner } = await loadFixture(deployLiquidityOrchestratorFixture);
      const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
      const liquidityOrchestrator = await LiquidityOrchestratorFactory.deploy();
      await liquidityOrchestrator.waitForDeployment();

      await expect(
        liquidityOrchestrator.initialize(owner.address, automationRegistry.address, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(liquidityOrchestrator, "ZeroAddress");
    });
  });

  describe("Access Control", function () {
    it("Should only allow owner to set adapters", async function () {
      const { liquidityOrchestratorContract, erc4626Asset1, erc4626ExecutionAdapter, unauthorized } = await loadFixture(
        deployLiquidityOrchestratorFixture,
      );

      await expect(
        liquidityOrchestratorContract
          .connect(unauthorized)
          .setAdapter(await erc4626Asset1.getAddress(), await erc4626ExecutionAdapter.getAddress()),
      ).to.be.revertedWithCustomError(liquidityOrchestratorContract, "OwnableUnauthorizedAccount");
    });

    it("Should only allow automation registry to perform upkeep", async function () {
      const { liquidityOrchestratorContract, unauthorized } = await loadFixture(deployLiquidityOrchestratorFixture);

      await expect(
        liquidityOrchestratorContract.connect(unauthorized).performUpkeep("0x"),
      ).to.be.revertedWithCustomError(liquidityOrchestratorContract, "NotAuthorized");
    });
  });

  describe("Adapter Management", function () {
    it("Should set and get adapters correctly", async function () {
      const { liquidityOrchestratorContract, erc4626Asset1, erc4626Asset2, erc4626ExecutionAdapter } =
        await loadFixture(deployLiquidityOrchestratorFixture);

      // Set adapter for erc4626Asset1
      expect(await liquidityOrchestratorContract.executionAdapterOf(await erc4626Asset1.getAddress())).to.equal(
        await erc4626ExecutionAdapter.getAddress(),
      );

      expect(await liquidityOrchestratorContract.executionAdapterOf(await erc4626Asset2.getAddress())).to.equal(
        await erc4626ExecutionAdapter.getAddress(),
      );
    });

    it("Should revert when setting adapter with zero asset address", async function () {
      const { liquidityOrchestratorContract, erc4626ExecutionAdapter } = await loadFixture(
        deployLiquidityOrchestratorFixture,
      );

      await expect(
        liquidityOrchestratorContract.setAdapter(ethers.ZeroAddress, await erc4626ExecutionAdapter.getAddress()),
      ).to.be.revertedWithCustomError(liquidityOrchestratorContract, "ZeroAddress");
    });

    it("Should revert when setting adapter with zero adapter address", async function () {
      const { liquidityOrchestratorContract, erc4626Asset1 } = await loadFixture(deployLiquidityOrchestratorFixture);

      await expect(
        liquidityOrchestratorContract.setAdapter(await erc4626Asset1.getAddress(), ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(liquidityOrchestratorContract, "ZeroAddress");
    });
  });

  describe("Complete Flow with _executeSell and _executeBuy", function () {
    it("Should generate only buying orders when starting from empty portfolio", async function () {
      const {
        liquidityOrchestratorContract,
        internalStatesOrchestrator,
        underlyingAsset,
        erc4626Asset1,
        erc4626Asset2,
        vault1,
        vault2,
        curator1,
        curator2,
        depositor1,
        depositor2,
        automationRegistry,
      } = await loadFixture(deployLiquidityOrchestratorFixture);

      // Step 1: Depositors request deposits into vaults
      const deposit1Amount = ethers.parseUnits("10000", 6);
      const deposit2Amount = ethers.parseUnits("15000", 6);

      await underlyingAsset.connect(depositor1).approve(await vault1.getAddress(), deposit1Amount);
      await vault1.connect(depositor1).requestDeposit(deposit1Amount);

      await underlyingAsset.connect(depositor2).approve(await vault2.getAddress(), deposit2Amount);
      await vault2.connect(depositor2).requestDeposit(deposit2Amount);

      await ethers.provider.send("hardhat_setBalance", [
        await liquidityOrchestratorContract.getAddress(),
        ethers.toBeHex(ethers.parseEther("10")),
      ]);

      // Step 2: Curators submit new intents
      // Curator 1: Wants 40% ERC4626Asset1, 60% ERC4626Asset2
      await vault1.connect(curator1).submitIntent([
        { token: await erc4626Asset1.getAddress(), weight: 400000 }, // 40%
        { token: await erc4626Asset2.getAddress(), weight: 600000 }, // 60%
      ]);

      // Curator 2: Wants 50% ERC4626Asset1, 50% ERC4626Asset2
      await vault2.connect(curator2).submitIntent([
        { token: await erc4626Asset1.getAddress(), weight: 500000 }, // 50%
        { token: await erc4626Asset2.getAddress(), weight: 500000 }, // 50%
      ]);

      // Step 3: Verify initial state - both vaults should have empty portfolios
      const [vault1PortfolioTokens, _vault1PortfolioWeights] = await vault1.getPortfolio();
      const [vault2PortfolioTokens, _vault2PortfolioWeights] = await vault2.getPortfolio();

      expect(vault1PortfolioTokens.length).to.equal(0);
      expect(vault2PortfolioTokens.length).to.equal(0);

      // Step 4: Trigger Internal States Orchestrator
      await ethers.provider.send("evm_increaseTime", [1e18]);
      await ethers.provider.send("evm_mine", []);

      // Check that upkeep is needed
      const [internalUpkeepNeeded] = await internalStatesOrchestrator.checkUpkeep("0x");
      expect(internalUpkeepNeeded).to.be.true;

      // Perform internal states orchestrator upkeep
      await expect(internalStatesOrchestrator.connect(automationRegistry).performUpkeep("0x")).to.emit(
        internalStatesOrchestrator,
        "InternalStateProcessed",
      );

      // Step 5: Verify the expected behavior
      const [sellingTokens, sellingAmounts] = await internalStatesOrchestrator.getSellingOrders();
      const [buyingTokens, buyingAmounts] = await internalStatesOrchestrator.getBuyingOrders();

      // Debug: Check vault states before assertions
      console.log("=== TEST VERIFICATION ===");
      const [vault1IntentTokens, _vault1IntentWeights] = await vault1.getIntent();
      const [vault2IntentTokens, _vault2IntentWeights] = await vault2.getIntent();
      console.log(
        "Vault1 Intent tokens:",
        vault1IntentTokens.length,
        "Vault2 Intent tokens:",
        vault2IntentTokens.length,
      );

      console.log("Vault1 Pending Deposits:", ethers.formatUnits(await vault1.getPendingDeposits(), 6), "USDC");
      console.log("Vault2 Pending Deposits:", ethers.formatUnits(await vault2.getPendingDeposits(), 6), "USDC");

      // Since we start with empty portfolios, there should be NO selling orders
      expect(sellingTokens.length).to.equal(0);
      expect(sellingAmounts.length).to.equal(0);

      // Buying orders should contain the union of tokens from both intents
      expect(buyingTokens.length).to.equal(2); // ERC4626Asset1 and ERC4626Asset2

      // Verify that both tokens are in the buying orders
      const erc4626Asset1Address = await erc4626Asset1.getAddress();
      const erc4626Asset2Address = await erc4626Asset2.getAddress();

      expect(buyingTokens).to.include(erc4626Asset1Address);
      expect(buyingTokens).to.include(erc4626Asset2Address);

      // Verify buying amounts are greater than 0
      expect(buyingAmounts.length).to.equal(2);
      expect(buyingAmounts[0]).to.be.greaterThan(0);
      expect(buyingAmounts[1]).to.be.greaterThan(0);

      console.log("✅ PASSED: Selling tokens are empty (empty portfolio case)");
      console.log("✅ PASSED: Buying tokens contain union of intent tokens");
      console.log(
        "✅ PASSED: Buying amounts:",
        buyingAmounts.map((amount) => ethers.formatUnits(amount, 6)).join(", "),
        "USDC",
      );
    });

    it("Should successfully execute the complete rebalancing flow", async function () {
      const {
        liquidityOrchestratorContract,
        internalStatesOrchestrator,
        underlyingAsset,
        erc4626Asset1,
        erc4626Asset2,
        vault1,
        vault2,
        curator1,
        curator2,
        depositor1,
        depositor2,
        automationRegistry,
      } = await loadFixture(deployLiquidityOrchestratorFixture);

      // Step 1: Depositors request deposits into vaults
      const deposit1Amount = ethers.parseUnits("10000", 6);
      const deposit2Amount = ethers.parseUnits("15000", 6);

      await underlyingAsset.connect(depositor1).approve(await vault1.getAddress(), deposit1Amount);
      await vault1.connect(depositor1).requestDeposit(deposit1Amount);

      await underlyingAsset.connect(depositor2).approve(await vault2.getAddress(), deposit2Amount);
      await vault2.connect(depositor2).requestDeposit(deposit2Amount);

      // Step 2: Fund the liquidity orchestrator contract address with ETH for gas using hardhat_setBalance
      await ethers.provider.send("hardhat_setBalance", [
        await liquidityOrchestratorContract.getAddress(),
        ethers.toBeHex(ethers.parseEther("10")),
      ]);

      // Step 3: Curators submit new intents
      // Curator 1: Wants 30% ERC4626Asset1, 70% ERC4626Asset2
      await vault1.connect(curator1).submitIntent([
        { token: await erc4626Asset1.getAddress(), weight: 300000 }, // 30%
        { token: await erc4626Asset2.getAddress(), weight: 700000 }, // 70%
      ]);

      // Curator 2: Wants 55% ERC4626Asset1, 45% ERC4626Asset2
      await vault2.connect(curator2).submitIntent([
        { token: await erc4626Asset1.getAddress(), weight: 550000 }, // 55%
        { token: await erc4626Asset2.getAddress(), weight: 450000 }, // 45%
      ]);

      // Step 4: Trigger Internal States Orchestrator
      await ethers.provider.send("evm_increaseTime", [1e18]);
      await ethers.provider.send("evm_mine", []);

      // Check that upkeep is needed
      const [internalUpkeepNeeded] = await internalStatesOrchestrator.checkUpkeep("0x");
      expect(internalUpkeepNeeded).to.be.true;

      // Perform upkeep
      await expect(internalStatesOrchestrator.connect(automationRegistry).performUpkeep("0x")).to.emit(
        internalStatesOrchestrator,
        "InternalStateProcessed",
      );

      // Verify epoch counter increased
      expect(await internalStatesOrchestrator.epochCounter()).to.equal(1);

      // Step 5: Check that Liquidity Orchestrator needs upkeep
      const [liquidityUpkeepNeeded] = await liquidityOrchestratorContract.checkUpkeep("0x");
      expect(liquidityUpkeepNeeded).to.be.true;

      // Step 6: Get initial balances
      const initialUnderlyingBalance = await underlyingAsset.balanceOf(
        await liquidityOrchestratorContract.getAddress(),
      );
      const initialAsset1Balance = await erc4626Asset1.balanceOf(await liquidityOrchestratorContract.getAddress());
      const initialAsset2Balance = await erc4626Asset2.balanceOf(await liquidityOrchestratorContract.getAddress());

      console.log("Initial balances:");
      console.log("Underlying:", ethers.formatUnits(initialUnderlyingBalance, 6));
      console.log("Asset1:", ethers.formatUnits(initialAsset1Balance, 18));
      console.log("Asset2:", ethers.formatUnits(initialAsset2Balance, 18));

      // Step 7: Execute Liquidity Orchestrator upkeep (this will call _executeSell and _executeBuy)
      await expect(liquidityOrchestratorContract.connect(automationRegistry).performUpkeep("0x")).to.emit(
        liquidityOrchestratorContract,
        "PortfolioRebalanced",
      );

      // Step 8: Verify that epoch was processed
      expect(await liquidityOrchestratorContract.lastProcessedEpoch()).to.equal(1);

      // Step 9: Check final balances to verify execution
      const finalUnderlyingBalance = await underlyingAsset.balanceOf(await liquidityOrchestratorContract.getAddress());
      const finalAsset1Balance = await erc4626Asset1.balanceOf(await liquidityOrchestratorContract.getAddress());
      const finalAsset2Balance = await erc4626Asset2.balanceOf(await liquidityOrchestratorContract.getAddress());

      console.log("Final balances:");
      console.log("Underlying:", ethers.formatUnits(finalUnderlyingBalance, 6));
      console.log("Asset1:", ethers.formatUnits(finalAsset1Balance, 18));
      console.log("Asset2:", ethers.formatUnits(finalAsset2Balance, 18));

      // Verify that some trading occurred (balances should have changed)
      expect(
        finalUnderlyingBalance !== initialUnderlyingBalance ||
          finalAsset1Balance !== initialAsset1Balance ||
          finalAsset2Balance !== initialAsset2Balance,
      ).to.be.true;
    });

    it("Should not process same epoch twice", async function () {
      const { liquidityOrchestratorContract, internalStatesOrchestrator, automationRegistry } = await loadFixture(
        deployLiquidityOrchestratorFixture,
      );

      // Trigger internal states orchestrator to increment epoch
      await ethers.provider.send("evm_increaseTime", [1e18]);
      await ethers.provider.send("evm_mine", []);
      await internalStatesOrchestrator.connect(automationRegistry).performUpkeep("0x");

      // First execution should work
      await expect(liquidityOrchestratorContract.connect(automationRegistry).performUpkeep("0x")).to.emit(
        liquidityOrchestratorContract,
        "PortfolioRebalanced",
      );

      // Second execution should not emit event (same epoch)
      await expect(liquidityOrchestratorContract.connect(automationRegistry).performUpkeep("0x")).to.not.emit(
        liquidityOrchestratorContract,
        "PortfolioRebalanced",
      );
    });
  });
});
