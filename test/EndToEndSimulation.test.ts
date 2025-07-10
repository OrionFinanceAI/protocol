import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("End-to-End Protocol Simulation", function () {
  // Test fixture setup for end-to-end scenarios
  async function deployProtocolFixture() {
    const [owner, automationRegistry, curator1, curator2, depositor1, depositor2, unauthorized] =
      await ethers.getSigners();

    // Deploy underlying asset (USDC-like, 6 decimals)
    const UnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAsset = await UnderlyingAssetFactory.deploy(6);
    await underlyingAsset.waitForDeployment();

    // Deploy ERC4626 assets
    const ERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");

    const erc4626Asset1 = await ERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Vault Token 1",
      "VT1",
      18,
    );
    await erc4626Asset1.waitForDeployment();

    const erc4626Asset2 = await ERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Vault Token 2",
      "VT2",
      18,
    );
    await erc4626Asset2.waitForDeployment();

    const erc4626Asset3 = await ERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Vault Token 3",
      "VT3",
      18,
    );
    await erc4626Asset3.waitForDeployment();

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

    // Deploy OrionVaultFactory and vault implementations
    const OrionVaultFactoryFactory = await ethers.getContractFactory("OrionVaultFactory");
    const orionVaultFactory = await OrionVaultFactoryFactory.deploy();
    await orionVaultFactory.waitForDeployment();
    await orionVaultFactory.initialize(owner.address, await config.getAddress());

    // Deploy vault implementations
    const OrionTransparentVaultFactory = await ethers.getContractFactory("OrionTransparentVault");
    const transparentVaultImpl = await OrionTransparentVaultFactory.deploy();
    await transparentVaultImpl.waitForDeployment();

    const OrionEncryptedVaultFactory = await ethers.getContractFactory("OrionEncryptedVault");
    const encryptedVaultImpl = await OrionEncryptedVaultFactory.deploy();
    await encryptedVaultImpl.waitForDeployment();

    // Set implementations in factory
    await orionVaultFactory.setImplementations(
      await transparentVaultImpl.getAddress(),
      await encryptedVaultImpl.getAddress(),
    );

    // Set protocol parameters in OrionConfig BEFORE initializing LiquidityOrchestrator
    await config.setProtocolParams(
      await underlyingAsset.getAddress(),
      await internalStatesOrchestrator.getAddress(),
      await liquidityOrchestratorContract.getAddress(),
      6, // curatorIntentDecimals
      await orionVaultFactory.getAddress(), // factory
      await oracleRegistry.getAddress(),
    );

    // Whitelist the ERC4626 assets so they can be used in vault intents
    await config.addWhitelistedAsset(await erc4626Asset1.getAddress());
    await config.addWhitelistedAsset(await erc4626Asset2.getAddress());
    await config.addWhitelistedAsset(await erc4626Asset3.getAddress());

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
    await oracleRegistry.setAdapter(await erc4626Asset3.getAddress(), await erc4626Oracle.getAddress());

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
    await liquidityOrchestratorContract.setAdapter(
      await erc4626Asset3.getAddress(),
      await erc4626ExecutionAdapter.getAddress(),
    );

    // Create vaults through the factory (this will automatically register them)
    const vault1Tx = await orionVaultFactory.createOrionTransparentVault(curator1.address, "Test Vault 1", "TV1");
    const vault1Receipt = await vault1Tx.wait();
    const vault1Address = vault1Receipt.logs[0].address;

    const vault2Tx = await orionVaultFactory.createOrionTransparentVault(curator2.address, "Test Vault 2", "TV2");
    const vault2Receipt = await vault2Tx.wait();
    const vault2Address = vault2Receipt.logs[0].address;

    // Get the vault contract instances
    const vault1 = await ethers.getContractAt("OrionTransparentVault", vault1Address);
    const vault2 = await ethers.getContractAt("OrionTransparentVault", vault2Address);

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
      erc4626Asset3,
      vault1,
      vault2,
      erc4626ExecutionAdapter,
      owner,
      automationRegistry,
      vaultFactory: orionVaultFactory,
      curator1,
      curator2,
      depositor1,
      depositor2,
      unauthorized,
      erc4626Oracle,
    };
  }

  describe("Scenario 1: Empty Portfolio Initialization", function () {
    it("Should generate correct buying orders when starting from empty portfolio", async function () {
      const {
        liquidityOrchestratorContract,
        internalStatesOrchestrator,
        underlyingAsset,
        erc4626Asset1,
        erc4626Asset2,
        erc4626Asset3,
        vault1,
        vault2,
        curator1,
        curator2,
        depositor1,
        depositor2,
        automationRegistry,
      } = await loadFixture(deployProtocolFixture);

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
        { token: await erc4626Asset1.getAddress(), value: 400000 }, // 40%
        { token: await erc4626Asset2.getAddress(), value: 600000 }, // 60%
      ]);

      // Curator 2: Wants 50% ERC4626Asset1, 50% ERC4626Asset2
      await vault2.connect(curator2).submitIntent([
        { token: await erc4626Asset1.getAddress(), value: 500000 }, // 50%
        { token: await erc4626Asset2.getAddress(), value: 500000 }, // 50%
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
      expect(buyingTokens).not.to.include(await erc4626Asset3.getAddress());

      // Verify buying amounts are greater than 0
      expect(buyingAmounts.length).to.equal(2);

      const expectedAsset1Amount = ethers.parseUnits("11500", 6); // 10_000 * 0.4 + 15_000 * 0.5
      const expectedAsset2Amount = ethers.parseUnits("13500", 6); // 10_000 * 0.6 + 15_000 * 0.5

      const actualBuyingMap = new Map<string, bigint>();
      for (let i = 0; i < buyingTokens.length; i++) {
        actualBuyingMap.set(buyingTokens[i], buyingAmounts[i]);
      }

      expect(actualBuyingMap.get(await erc4626Asset1.getAddress())).to.equal(expectedAsset1Amount);
      expect(actualBuyingMap.get(await erc4626Asset2.getAddress())).to.equal(expectedAsset2Amount);
    });
  });

  describe("Scenario 2: Complete Rebalancing Flow", function () {
    it("Should successfully execute the complete rebalancing flow", async function () {
      const {
        liquidityOrchestratorContract,
        internalStatesOrchestrator,
        underlyingAsset,
        erc4626Asset1,
        erc4626Asset2,
        erc4626Asset3,
        vault1,
        vault2,
        curator1,
        curator2,
        depositor1,
        depositor2,
        automationRegistry,
      } = await loadFixture(deployProtocolFixture);

      // Step 1: Depositors request deposits into vaults
      const deposit1Amount = ethers.parseUnits("10000", 6);
      const deposit21Amount = ethers.parseUnits("7000", 6);
      const deposit2Amount = ethers.parseUnits("15000", 6);

      await underlyingAsset.connect(depositor1).approve(await vault1.getAddress(), deposit1Amount);
      await vault1.connect(depositor1).requestDeposit(deposit1Amount);

      await underlyingAsset.connect(depositor2).approve(await vault1.getAddress(), deposit21Amount);
      await vault1.connect(depositor2).requestDeposit(deposit21Amount);

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
        { token: await erc4626Asset1.getAddress(), value: 300000 }, // 30%
        { token: await erc4626Asset2.getAddress(), value: 700000 }, // 70%
      ]);

      // Curator 2: Wants 55% ERC4626Asset1, 45% ERC4626Asset2
      await vault2.connect(curator2).submitIntent([
        { token: await erc4626Asset1.getAddress(), value: 550000 }, // 55%
        { token: await erc4626Asset2.getAddress(), value: 450000 }, // 45%
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

      // Step 5: Verify the expected behavior
      const [sellingTokens, sellingAmounts] = await internalStatesOrchestrator.getSellingOrders();
      const [buyingTokens, buyingAmounts] = await internalStatesOrchestrator.getBuyingOrders();

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
      expect(buyingTokens).not.to.include(await erc4626Asset3.getAddress());

      // Verify buying amounts are greater than 0
      expect(buyingAmounts.length).to.equal(2);

      const expectedAsset1Amount = ethers.parseUnits("13350", 6); // 17_000 * 0.3 + 15_000 * 0.55
      const expectedAsset2Amount = ethers.parseUnits("18650", 6); // 17_000 * 0.7 + 15_000 * 0.45

      const actualBuyingMap = new Map<string, bigint>();
      for (let i = 0; i < buyingTokens.length; i++) {
        actualBuyingMap.set(buyingTokens[i], buyingAmounts[i]);
      }

      expect(actualBuyingMap.get(await erc4626Asset1.getAddress())).to.equal(expectedAsset1Amount);
      expect(actualBuyingMap.get(await erc4626Asset2.getAddress())).to.equal(expectedAsset2Amount);

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
      const initialAsset3Balance = await erc4626Asset3.balanceOf(await liquidityOrchestratorContract.getAddress());

      expect(initialUnderlyingBalance).to.equal(ethers.parseUnits("32000", 6)); // 10_000 + 7_000 + 15_000
      expect(initialAsset1Balance).to.equal(ethers.parseUnits("0", 6));
      expect(initialAsset2Balance).to.equal(ethers.parseUnits("0", 6));
      expect(initialAsset3Balance).to.equal(ethers.parseUnits("0", 6));

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
      const finalAsset3Balance = await erc4626Asset3.balanceOf(await liquidityOrchestratorContract.getAddress());

      expect(finalUnderlyingBalance).to.equal(ethers.parseUnits("0", 6));

      expect(finalAsset1Balance).to.equal(ethers.parseUnits("0.000000013350", 18)); // 13_350 * 1e6 / 1e18
      expect(finalAsset2Balance).to.equal(ethers.parseUnits("0.000000018650", 18)); // 18_650 * 1e6 / 1e18
      expect(finalAsset3Balance).to.equal(ethers.parseUnits("0", 6));
    });

    it("Should not process same epoch twice", async function () {
      const { liquidityOrchestratorContract, internalStatesOrchestrator, automationRegistry } =
        await loadFixture(deployProtocolFixture);

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
