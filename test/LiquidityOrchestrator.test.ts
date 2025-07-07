import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("LiquidityOrchestrator", function () {
  // Test fixture setup
  async function deployLiquidityOrchestratorFixture() {
    const [owner, automationRegistry, vaultFactory, curator1, curator2, depositor1, depositor2, unauthorized] =
      await ethers.getSigners();

    // Deploy mock underlying asset (USDC-like, 6 decimals)
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAsset = await MockUnderlyingAssetFactory.deploy();
    await underlyingAsset.waitForDeployment();

    // Deploy mock ERC4626 assets for trading
    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    const erc4626Asset1 = await MockERC4626AssetFactory.deploy(underlyingAsset, "Vault Token 1", "VT1");
    await erc4626Asset1.waitForDeployment();

    const erc4626Asset2 = await MockERC4626AssetFactory.deploy(underlyingAsset, "Vault Token 2", "VT2");
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

    // Initialize LiquidityOrchestrator after protocol parameters are set
    await liquidityOrchestratorContract.initialize(
      owner.address,
      automationRegistry.address,
      await config.getAddress(),
    );

    // Deploy mock price adapters for oracles
    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");

    const underlyingOracle = await MockPriceAdapterFactory.deploy();
    await underlyingOracle.waitForDeployment();
    await underlyingOracle.initialize(owner.address);

    const erc4626Oracle1 = await MockPriceAdapterFactory.deploy();
    await erc4626Oracle1.waitForDeployment();
    await erc4626Oracle1.initialize(owner.address);

    const erc4626Oracle2 = await MockPriceAdapterFactory.deploy();
    await erc4626Oracle2.waitForDeployment();
    await erc4626Oracle2.initialize(owner.address);

    // Set oracles in registry
    await oracleRegistry.setAdapter(await underlyingAsset.getAddress(), await underlyingOracle.getAddress());
    await oracleRegistry.setAdapter(await erc4626Asset1.getAddress(), await erc4626Oracle1.getAddress());
    await oracleRegistry.setAdapter(await erc4626Asset2.getAddress(), await erc4626Oracle2.getAddress());

    // Deploy execution adapters for ERC4626 assets
    const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");

    const adapter1 = await ERC4626ExecutionAdapterFactory.deploy(await erc4626Asset1.getAddress());
    await adapter1.waitForDeployment();

    const adapter2 = await ERC4626ExecutionAdapterFactory.deploy(await erc4626Asset2.getAddress());
    await adapter2.waitForDeployment();

    // Set adapters in LiquidityOrchestrator
    await (liquidityOrchestratorContract as any).setAdapter(
      await erc4626Asset1.getAddress(),
      await adapter1.getAddress(),
    );
    await (liquidityOrchestratorContract as any).setAdapter(
      await erc4626Asset2.getAddress(),
      await adapter2.getAddress(),
    );

    // Deploy two transparent vaults
    const OrionTransparentVaultFactory = await ethers.getContractFactory("OrionTransparentVault");

    const vault1 = await OrionTransparentVaultFactory.deploy();
    await vault1.waitForDeployment();
    await vault1.initialize(curator1.address, await config.getAddress(), "Test Vault 1", "TV1");

    const vault2 = await OrionTransparentVaultFactory.deploy();
    await vault2.waitForDeployment();
    await vault2.initialize(curator2.address, await config.getAddress(), "Test Vault 2", "TV2");

    // Add vaults to config (cast to any to avoid TypeScript issues)
    await (config as any).connect(vaultFactory).addOrionVault(await vault1.getAddress(), 1); // Transparent
    await (config as any).connect(vaultFactory).addOrionVault(await vault2.getAddress(), 1); // Transparent

    // Mint underlying assets to depositors and liquidity orchestrator
    await underlyingAsset.mint(depositor1.address, ethers.parseUnits("100000", 6));
    await underlyingAsset.mint(depositor2.address, ethers.parseUnits("100000", 6));
    await underlyingAsset.mint(await liquidityOrchestratorContract.getAddress(), ethers.parseUnits("1000000", 6));

    // Setup ERC4626 assets with liquidity for selling/buying
    // Mint underlying assets to owner for depositing into ERC4626 vaults
    await underlyingAsset.mint(owner.address, ethers.parseUnits("100000", 6));

    // Owner approves and deposits underlying assets to get ERC4626 shares, then transfers to liquidity orchestrator
    await (underlyingAsset as any)
      .connect(owner)
      .approve(await erc4626Asset1.getAddress(), ethers.parseUnits("50000", 6));
    await (erc4626Asset1 as any).connect(owner).deposit(ethers.parseUnits("50000", 6), owner.address);
    const erc4626Balance1 = await erc4626Asset1.balanceOf(owner.address);
    await (erc4626Asset1 as any)
      .connect(owner)
      .transfer(await liquidityOrchestratorContract.getAddress(), erc4626Balance1);

    await (underlyingAsset as any)
      .connect(owner)
      .approve(await erc4626Asset2.getAddress(), ethers.parseUnits("50000", 6));
    await (erc4626Asset2 as any).connect(owner).deposit(ethers.parseUnits("50000", 6), owner.address);
    const erc4626Balance2 = await erc4626Asset2.balanceOf(owner.address);
    await (erc4626Asset2 as any)
      .connect(owner)
      .transfer(await liquidityOrchestratorContract.getAddress(), erc4626Balance2);

    // Ensure ERC4626 vaults have underlying assets for proper exchange rates
    await underlyingAsset.mint(await erc4626Asset1.getAddress(), ethers.parseUnits("1000000", 6));
    await underlyingAsset.mint(await erc4626Asset2.getAddress(), ethers.parseUnits("1000000", 6));

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
      adapter1,
      adapter2,
      owner,
      automationRegistry,
      vaultFactory,
      curator1,
      curator2,
      depositor1,
      depositor2,
      unauthorized,
      underlyingOracle,
      erc4626Oracle1,
      erc4626Oracle2,
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
      const { liquidityOrchestratorContract, erc4626Asset1, adapter1, unauthorized } = await loadFixture(
        deployLiquidityOrchestratorFixture,
      );

      await expect(
        liquidityOrchestratorContract
          .connect(unauthorized)
          .setAdapter(await erc4626Asset1.getAddress(), await adapter1.getAddress()),
      ).to.be.revertedWithCustomError(liquidityOrchestratorContract, "OwnableUnauthorizedAccount");
    });

    it("Should only allow automation registry to perform upkeep", async function () {
      const { liquidityOrchestratorContract, unauthorized } = await loadFixture(deployLiquidityOrchestratorFixture);

      await expect(
        (liquidityOrchestratorContract as any).connect(unauthorized).performUpkeep("0x"),
      ).to.be.revertedWithCustomError(liquidityOrchestratorContract, "NotAuthorized");
    });
  });

  describe("Adapter Management", function () {
    it("Should set and get adapters correctly", async function () {
      const { liquidityOrchestratorContract, erc4626Asset1, adapter1 } = await loadFixture(
        deployLiquidityOrchestratorFixture,
      );

      expect(await liquidityOrchestratorContract.executionAdapterOf(await erc4626Asset1.getAddress())).to.equal(
        await adapter1.getAddress(),
      );
    });

    it("Should revert when setting adapter with zero asset address", async function () {
      const { liquidityOrchestratorContract, adapter1 } = await loadFixture(deployLiquidityOrchestratorFixture);

      await expect(
        (liquidityOrchestratorContract as any).setAdapter(ethers.ZeroAddress, await adapter1.getAddress()),
      ).to.be.revertedWithCustomError(liquidityOrchestratorContract, "ZeroAddress");
    });

    it("Should revert when setting adapter with zero adapter address", async function () {
      const { liquidityOrchestratorContract, erc4626Asset1 } = await loadFixture(deployLiquidityOrchestratorFixture);

      await expect(
        (liquidityOrchestratorContract as any).setAdapter(await erc4626Asset1.getAddress(), ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(liquidityOrchestratorContract, "ZeroAddress");
    });
  });

  describe("Complete Flow with _executeSell and _executeBuy", function () {
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
        owner,
      } = await loadFixture(deployLiquidityOrchestratorFixture);

      // Step 1: Depositors deposit funds into vaults
      const deposit1Amount = ethers.parseUnits("10000", 6); // 10000 USDC (6 decimals)
      const deposit2Amount = ethers.parseUnits("15000", 6); // 15000 USDC (6 decimals)

      await (underlyingAsset as any).connect(depositor1).approve(await vault1.getAddress(), deposit1Amount);
      await (vault1 as any).connect(depositor1).requestDeposit(deposit1Amount);

      await (underlyingAsset as any).connect(depositor2).approve(await vault2.getAddress(), deposit2Amount);
      await (vault2 as any).connect(depositor2).requestDeposit(deposit2Amount);

      // Step 2: Process deposit requests (simulate liquidity orchestrator processing)
      // Use hardhat impersonation to call as the liquidity orchestrator
      // First, fund the contract address with ETH for gas using hardhat_setBalance
      await ethers.provider.send("hardhat_setBalance", [
        await liquidityOrchestratorContract.getAddress(),
        ethers.toBeHex(ethers.parseEther("10")), // Set balance to 10 ETH
      ]);

      await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestratorContract.getAddress()]);
      const liquidityOrchestratorSigner = await ethers.getSigner(await liquidityOrchestratorContract.getAddress());

      await (vault1 as any).connect(liquidityOrchestratorSigner).processDepositRequests();
      await (vault2 as any).connect(liquidityOrchestratorSigner).processDepositRequests();

      // Step 3: Set initial portfolio states for both vaults
      // Vault 1: 60% ERC4626Asset1, 40% ERC4626Asset2
      await (vault1 as any).connect(liquidityOrchestratorSigner).updateVaultState(
        [
          { token: await erc4626Asset1.getAddress(), weight: 600000 },
          { token: await erc4626Asset2.getAddress(), weight: 400000 },
        ],
        deposit1Amount,
      );

      // Vault 2: 80% ERC4626Asset1, 20% ERC4626Asset2
      await (vault2 as any).connect(liquidityOrchestratorSigner).updateVaultState(
        [
          { token: await erc4626Asset1.getAddress(), weight: 800000 },
          { token: await erc4626Asset2.getAddress(), weight: 200000 },
        ],
        deposit2Amount,
      );

      // Stop impersonation
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [
        await liquidityOrchestratorContract.getAddress(),
      ]);

      // Step 4: Curators submit new intents
      // Curator 1: Wants 40% ERC4626Asset1, 60% ERC4626Asset2 (rebalance to more Asset2)
      await (vault1 as any).connect(curator1).submitIntent([
        { token: await erc4626Asset1.getAddress(), weight: 400000 },
        { token: await erc4626Asset2.getAddress(), weight: 600000 },
      ]);

      // Curator 2: Wants 50% ERC4626Asset1, 50% ERC4626Asset2 (rebalance to less Asset1)
      await (vault2 as any).connect(curator2).submitIntent([
        { token: await erc4626Asset1.getAddress(), weight: 500000 },
        { token: await erc4626Asset2.getAddress(), weight: 500000 },
      ]);

      // Step 5: Trigger Internal States Orchestrator
      await ethers.provider.send("evm_increaseTime", [70]); // Move time forward
      await ethers.provider.send("evm_mine", []);

      // Check that upkeep is needed
      const [internalUpkeepNeeded] = await internalStatesOrchestrator.checkUpkeep("0x");
      expect(internalUpkeepNeeded).to.be.true;

      // Perform internal states orchestrator upkeep
      await expect((internalStatesOrchestrator as any).connect(automationRegistry).performUpkeep("0x")).to.emit(
        internalStatesOrchestrator,
        "InternalStateProcessed",
      );

      // Verify epoch counter increased
      expect(await internalStatesOrchestrator.epochCounter()).to.equal(1);

      // Step 6: Get selling and buying orders
      const [sellingTokens, sellingAmounts] = await internalStatesOrchestrator.getSellingOrders();
      const [buyingTokens, buyingAmounts] = await internalStatesOrchestrator.getBuyingOrders();

      console.log("Selling tokens:", sellingTokens);
      console.log("Selling amounts:", sellingAmounts);
      console.log("Buying tokens:", buyingTokens);
      console.log("Buying amounts:", buyingAmounts);

      // Step 7: Check that Liquidity Orchestrator needs upkeep
      const [liquidityUpkeepNeeded] = await liquidityOrchestratorContract.checkUpkeep("0x");
      expect(liquidityUpkeepNeeded).to.be.true;

      // Step 8: Get initial balances
      const initialUnderlyingBalance = await underlyingAsset.balanceOf(
        await liquidityOrchestratorContract.getAddress(),
      );
      const initialAsset1Balance = await erc4626Asset1.balanceOf(await liquidityOrchestratorContract.getAddress());
      const initialAsset2Balance = await erc4626Asset2.balanceOf(await liquidityOrchestratorContract.getAddress());

      console.log("Initial balances:");
      console.log("Underlying:", ethers.formatUnits(initialUnderlyingBalance, 6));
      console.log("Asset1:", ethers.formatUnits(initialAsset1Balance, 18));
      console.log("Asset2:", ethers.formatUnits(initialAsset2Balance, 18));

      // Step 9: Execute Liquidity Orchestrator upkeep (this will call _executeSell and _executeBuy)
      await expect((liquidityOrchestratorContract as any).connect(automationRegistry).performUpkeep("0x")).to.emit(
        liquidityOrchestratorContract,
        "PortfolioRebalanced",
      );

      // Step 10: Verify that epoch was processed
      expect(await liquidityOrchestratorContract.lastProcessedEpoch()).to.equal(1);

      // Step 11: Check final balances to verify execution
      const finalUnderlyingBalance = await underlyingAsset.balanceOf(await liquidityOrchestratorContract.getAddress());
      const finalAsset1Balance = await erc4626Asset1.balanceOf(await liquidityOrchestratorContract.getAddress());
      const finalAsset2Balance = await erc4626Asset2.balanceOf(await liquidityOrchestratorContract.getAddress());

      console.log("Final balances:");
      console.log("Underlying:", ethers.formatUnits(finalUnderlyingBalance, 6));
      console.log("Asset1:", ethers.formatUnits(finalAsset1Balance, 18));
      console.log("Asset2:", ethers.formatUnits(finalAsset2Balance, 18));

      // Verify that some trading occurred (balances should have changed)
      if (sellingTokens.length > 0 || buyingTokens.length > 0) {
        expect(
          finalUnderlyingBalance !== initialUnderlyingBalance ||
            finalAsset1Balance !== initialAsset1Balance ||
            finalAsset2Balance !== initialAsset2Balance,
        ).to.be.true;
      }
    });

    it("Should handle selling orders correctly", async function () {
      const {
        liquidityOrchestratorContract,
        internalStatesOrchestrator,
        underlyingAsset,
        erc4626Asset1,
        erc4626Asset2,
        vault1,
        curator1,
        depositor1,
        automationRegistry,
        owner,
      } = await loadFixture(deployLiquidityOrchestratorFixture);

      // Setup: Deposit and create initial portfolio with Asset1
      const depositAmount = ethers.parseUnits("10000", 6);
      await (underlyingAsset as any).connect(depositor1).approve(await vault1.getAddress(), depositAmount);
      await (vault1 as any).connect(depositor1).requestDeposit(depositAmount);
      // Impersonate liquidity orchestrator for authorized calls
      // First, fund the contract address with ETH for gas using hardhat_setBalance
      await ethers.provider.send("hardhat_setBalance", [
        await liquidityOrchestratorContract.getAddress(),
        ethers.toBeHex(ethers.parseEther("10")), // Set balance to 10 ETH
      ]);

      await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestratorContract.getAddress()]);
      const liquidityOrchestratorSigner = await ethers.getSigner(await liquidityOrchestratorContract.getAddress());

      await (vault1 as any).connect(liquidityOrchestratorSigner).processDepositRequests();

      // Set initial portfolio: 100% Asset1
      await (vault1 as any)
        .connect(liquidityOrchestratorSigner)
        .updateVaultState([{ token: await erc4626Asset1.getAddress(), weight: 1000000 }], depositAmount);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [
        await liquidityOrchestratorContract.getAddress(),
      ]);

      // Submit intent: 0% Asset1, 100% Asset2 (should trigger sell of Asset1, buy of Asset2)
      await (vault1 as any)
        .connect(curator1)
        .submitIntent([{ token: await erc4626Asset2.getAddress(), weight: 1000000 }]);

      // Trigger orchestrators
      await ethers.provider.send("evm_increaseTime", [70]);
      await ethers.provider.send("evm_mine", []);

      await (internalStatesOrchestrator as any).connect(automationRegistry).performUpkeep("0x");

      // Debug: Check portfolio and intent states
      const [portfolioTokens, portfolioWeights] = await vault1.getPortfolio();
      const [intentTokens, intentWeights] = await vault1.getIntent();
      console.log("Portfolio tokens:", portfolioTokens);
      console.log("Portfolio weights:", portfolioWeights);
      console.log("Intent tokens:", intentTokens);
      console.log("Intent weights:", intentWeights);

      // Check that there are selling orders
      const [sellingTokens, sellingAmounts] = await internalStatesOrchestrator.getSellingOrders();
      console.log("Selling tokens:", sellingTokens);
      console.log("Selling amounts:", sellingAmounts);
      expect(sellingTokens.length).to.be.greaterThan(0);
      expect(sellingTokens[0]).to.equal(await erc4626Asset1.getAddress());

      // Execute liquidity orchestrator
      const initialAsset1Balance = await erc4626Asset1.balanceOf(await liquidityOrchestratorContract.getAddress());
      const initialUnderlyingBalance = await underlyingAsset.balanceOf(
        await liquidityOrchestratorContract.getAddress(),
      );

      await (liquidityOrchestratorContract as any).connect(automationRegistry).performUpkeep("0x");

      // Verify sell executed (Asset1 balance should decrease, underlying should increase)
      const finalAsset1Balance = await erc4626Asset1.balanceOf(await liquidityOrchestratorContract.getAddress());
      const finalUnderlyingBalance = await underlyingAsset.balanceOf(await liquidityOrchestratorContract.getAddress());

      expect(finalAsset1Balance).to.be.lessThan(initialAsset1Balance);
      expect(finalUnderlyingBalance).to.be.greaterThan(initialUnderlyingBalance);
    });

    it("Should handle buying orders correctly", async function () {
      const {
        liquidityOrchestratorContract,
        internalStatesOrchestrator,
        underlyingAsset,
        erc4626Asset1,
        vault1,
        curator1,
        depositor1,
        automationRegistry,
        owner,
      } = await loadFixture(deployLiquidityOrchestratorFixture);

      // Setup: Deposit but no initial portfolio (start with 0% Asset1)
      const depositAmount = ethers.parseUnits("10000", 6);
      await (underlyingAsset as any).connect(depositor1).approve(await vault1.getAddress(), depositAmount);
      await (vault1 as any).connect(depositor1).requestDeposit(depositAmount);
      // Impersonate liquidity orchestrator for authorized calls
      // First, fund the contract address with ETH for gas using hardhat_setBalance
      await ethers.provider.send("hardhat_setBalance", [
        await liquidityOrchestratorContract.getAddress(),
        ethers.toBeHex(ethers.parseEther("10")), // Set balance to 10 ETH
      ]);

      await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestratorContract.getAddress()]);
      const liquidityOrchestratorSigner = await ethers.getSigner(await liquidityOrchestratorContract.getAddress());

      await (vault1 as any).connect(liquidityOrchestratorSigner).processDepositRequests();

      // Set initial portfolio: empty (no assets)
      await (vault1 as any).connect(liquidityOrchestratorSigner).updateVaultState([], depositAmount);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [
        await liquidityOrchestratorContract.getAddress(),
      ]);

      // Submit intent: 100% Asset1 (should trigger buy)
      await (vault1 as any)
        .connect(curator1)
        .submitIntent([{ token: await erc4626Asset1.getAddress(), weight: 1000000 }]);

      // Trigger orchestrators
      await ethers.provider.send("evm_increaseTime", [70]);
      await ethers.provider.send("evm_mine", []);

      await (internalStatesOrchestrator as any).connect(automationRegistry).performUpkeep("0x");

      // Check that there are buying orders
      const [buyingTokens, buyingAmounts] = await internalStatesOrchestrator.getBuyingOrders();
      expect(buyingTokens.length).to.be.greaterThan(0);
      expect(buyingTokens[0]).to.equal(await erc4626Asset1.getAddress());

      // Execute liquidity orchestrator
      const initialAsset1Balance = await erc4626Asset1.balanceOf(await liquidityOrchestratorContract.getAddress());
      const initialUnderlyingBalance = await underlyingAsset.balanceOf(
        await liquidityOrchestratorContract.getAddress(),
      );

      await (liquidityOrchestratorContract as any).connect(automationRegistry).performUpkeep("0x");

      // Verify buy executed (Asset1 balance should increase, underlying should decrease)
      const finalAsset1Balance = await erc4626Asset1.balanceOf(await liquidityOrchestratorContract.getAddress());
      const finalUnderlyingBalance = await underlyingAsset.balanceOf(await liquidityOrchestratorContract.getAddress());

      expect(finalAsset1Balance).to.be.greaterThan(initialAsset1Balance);
      expect(finalUnderlyingBalance).to.be.lessThan(initialUnderlyingBalance);
    });

    it("Should not process same epoch twice", async function () {
      const { liquidityOrchestratorContract, internalStatesOrchestrator, automationRegistry } = await loadFixture(
        deployLiquidityOrchestratorFixture,
      );

      // Trigger internal states orchestrator to increment epoch
      await ethers.provider.send("evm_increaseTime", [70]);
      await ethers.provider.send("evm_mine", []);
      await (internalStatesOrchestrator as any).connect(automationRegistry).performUpkeep("0x");

      // First execution should work
      await expect((liquidityOrchestratorContract as any).connect(automationRegistry).performUpkeep("0x")).to.emit(
        liquidityOrchestratorContract,
        "PortfolioRebalanced",
      );

      // Second execution should not emit event (same epoch)
      await expect((liquidityOrchestratorContract as any).connect(automationRegistry).performUpkeep("0x")).to.not.emit(
        liquidityOrchestratorContract,
        "PortfolioRebalanced",
      );
    });
  });

  describe("Error Handling", function () {
    it("Should revert sell execution when adapter not set", async function () {
      const {
        liquidityOrchestratorContract,
        internalStatesOrchestrator,
        underlyingAsset,
        erc4626Asset1,
        vault1,
        curator1,
        depositor1,
        automationRegistry,
        owner,
        config,
      } = await loadFixture(deployLiquidityOrchestratorFixture);

      // Deploy a new asset without setting its adapter
      const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
      const newAsset = await MockERC4626AssetFactory.deploy(underlyingAsset, "New Asset", "NA");
      await newAsset.waitForDeployment();

      // Setup vault with this new asset
      const depositAmount = ethers.parseUnits("10000", 6);
      await (underlyingAsset as any).connect(depositor1).approve(await vault1.getAddress(), depositAmount);
      await (vault1 as any).connect(depositor1).requestDeposit(depositAmount);
      // Impersonate liquidity orchestrator for authorized calls
      // First, fund the contract address with ETH for gas using hardhat_setBalance
      await ethers.provider.send("hardhat_setBalance", [
        await liquidityOrchestratorContract.getAddress(),
        ethers.toBeHex(ethers.parseEther("10")), // Set balance to 10 ETH
      ]);

      await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestratorContract.getAddress()]);
      const liquidityOrchestratorSigner = await ethers.getSigner(await liquidityOrchestratorContract.getAddress());

      await (vault1 as any).connect(liquidityOrchestratorSigner).processDepositRequests();

      await (vault1 as any)
        .connect(liquidityOrchestratorSigner)
        .updateVaultState([{ token: await newAsset.getAddress(), weight: 1000000 }], depositAmount);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [
        await liquidityOrchestratorContract.getAddress(),
      ]);

      // First, we need to whitelist the new asset
      await config.addWhitelistedAsset(await newAsset.getAddress());

      // Submit intent to sell (change from new asset to something else)
      await (vault1 as any)
        .connect(curator1)
        .submitIntent([{ token: await erc4626Asset1.getAddress(), weight: 1000000 }]);

      // Trigger orchestrators
      await ethers.provider.send("evm_increaseTime", [70]);
      await ethers.provider.send("evm_mine", []);
      await (internalStatesOrchestrator as any).connect(automationRegistry).performUpkeep("0x");

      // Should revert due to missing adapter
      await expect(
        (liquidityOrchestratorContract as any).connect(automationRegistry).performUpkeep("0x"),
      ).to.be.revertedWithCustomError(liquidityOrchestratorContract, "AdapterNotSet");
    });

    it("Should revert buy execution when adapter not set", async function () {
      const {
        liquidityOrchestratorContract,
        internalStatesOrchestrator,
        underlyingAsset,
        vault1,
        curator1,
        depositor1,
        automationRegistry,
        owner,
        config,
      } = await loadFixture(deployLiquidityOrchestratorFixture);

      // Deploy a new asset without setting its adapter
      const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
      const newAsset = await MockERC4626AssetFactory.deploy(underlyingAsset, "New Asset", "NA");
      await newAsset.waitForDeployment();

      // Setup vault with empty portfolio
      const depositAmount = ethers.parseUnits("10000", 6);
      await (underlyingAsset as any).connect(depositor1).approve(await vault1.getAddress(), depositAmount);
      await (vault1 as any).connect(depositor1).requestDeposit(depositAmount);
      // Impersonate liquidity orchestrator for authorized calls
      // First, fund the contract address with ETH for gas using hardhat_setBalance
      await ethers.provider.send("hardhat_setBalance", [
        await liquidityOrchestratorContract.getAddress(),
        ethers.toBeHex(ethers.parseEther("10")), // Set balance to 10 ETH
      ]);

      await ethers.provider.send("hardhat_impersonateAccount", [await liquidityOrchestratorContract.getAddress()]);
      const liquidityOrchestratorSigner = await ethers.getSigner(await liquidityOrchestratorContract.getAddress());

      await (vault1 as any).connect(liquidityOrchestratorSigner).processDepositRequests();

      await (vault1 as any).connect(liquidityOrchestratorSigner).updateVaultState([], depositAmount);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [
        await liquidityOrchestratorContract.getAddress(),
      ]);

      // First, we need to whitelist the new asset
      await config.addWhitelistedAsset(await newAsset.getAddress());

      // Submit intent to buy the new asset
      await (vault1 as any).connect(curator1).submitIntent([{ token: await newAsset.getAddress(), weight: 1000000 }]);

      // Trigger orchestrators
      await ethers.provider.send("evm_increaseTime", [70]);
      await ethers.provider.send("evm_mine", []);
      await (internalStatesOrchestrator as any).connect(automationRegistry).performUpkeep("0x");

      // Should revert due to missing adapter
      await expect(
        (liquidityOrchestratorContract as any).connect(automationRegistry).performUpkeep("0x"),
      ).to.be.revertedWithCustomError(liquidityOrchestratorContract, "AdapterNotSet");
    });
  });
});
