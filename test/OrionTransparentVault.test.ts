import { impersonateAccount, loadFixture, setBalance } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

import type { MockUnderlyingAsset, OrionConfig, OrionTransparentVault } from "../typechain-types";

describe("OrionTransparentVault", function () {
  // Test fixture setup
  async function deployVaultFixture() {
    const [owner, curator, lp1, lp2, internalOrchestrator, liquidityOrchestrator, unauthorized] =
      await ethers.getSigners();

    // Deploy mock underlying asset
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAsset = await MockUnderlyingAssetFactory.deploy(6);
    await underlyingAsset.waitForDeployment();
    const underlyingAssetAddress = await underlyingAsset.getAddress();

    // Deploy OrionConfig
    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    const config = await OrionConfigFactory.deploy();
    await config.waitForDeployment();
    const configAddress = await config.getAddress();
    await config.initialize(owner.address);
    await config.setUnderlyingAsset(underlyingAssetAddress);

    // Deploy PriceAdapterRegistry
    const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
    const priceAdapterRegistry = await PriceAdapterRegistryFactory.deploy();
    await priceAdapterRegistry.waitForDeployment();
    await priceAdapterRegistry.initialize(owner.address, await config.getAddress());

    // Deploy LiquidityOrchestrator
    const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
    const liquidityOrchestratorContract = await LiquidityOrchestratorFactory.deploy();
    await liquidityOrchestratorContract.waitForDeployment();
    const liquidityOrchestratorAddress = await liquidityOrchestratorContract.getAddress();

    // Initialize LiquidityOrchestrator
    await liquidityOrchestratorContract.initialize(
      owner.address,
      owner.address, // Using owner as automation registry for tests
      configAddress,
    );

    // Set protocol parameters using deployed contract address
    await config.setProtocolParams(
      liquidityOrchestratorAddress,
      6, // curatorIntentDecimals
      owner.address, // factory
      await priceAdapterRegistry.getAddress(), // priceAdapterRegistry
    );

    // Deploy OrionTransparentVault (concrete implementation of OrionVault)
    const OrionTransparentVaultFactory = await ethers.getContractFactory("OrionTransparentVault");
    const vault = await OrionTransparentVaultFactory.deploy();
    await vault.waitForDeployment();
    await vault.initialize(curator.address, configAddress, "Test Vault", "TV");

    // Register the vault in the config (since we're not using the factory)
    // Note: In production, this would be done by the OrionVaultFactory
    await config.addOrionVault(await vault.getAddress(), 0); // 0 = Transparent vault type

    // Mint some underlying assets to LPs for testing
    await underlyingAsset.mint(lp1.address, ethers.parseUnits("10000", 6));
    await underlyingAsset.mint(lp2.address, ethers.parseUnits("10000", 6));

    // Mint some underlying assets to the liquidityOrchestrator for cancel operations
    await underlyingAsset.mint(liquidityOrchestratorAddress, ethers.parseUnits("10000", 6));

    return {
      vault: vault as unknown as OrionTransparentVault,
      config: config as unknown as OrionConfig,
      underlyingAsset: underlyingAsset as unknown as MockUnderlyingAsset,
      owner,
      curator,
      lp1,
      lp2,
      internalOrchestrator,
      liquidityOrchestrator,
      liquidityOrchestratorContract,
      liquidityOrchestratorAddress,
      unauthorized,
    };
  }

  describe("Initialization", function () {
    it("Should initialize with correct parameters", async function () {
      const { vault, config, underlyingAsset, curator } = await loadFixture(deployVaultFixture);
      expect(await vault.curator()).to.equal(curator.address);
      expect(await vault.config()).to.equal(await config.getAddress());
      expect(await vault.asset()).to.equal(await underlyingAsset.getAddress());
      expect(await vault.name()).to.equal("Test Vault");
      expect(await vault.symbol()).to.equal("TV");
      expect(await vault.decimals()).to.equal(6);
      expect(await vault.totalAssets()).to.equal(0);
    });
    it("Should revert if initialized with zero curator address", async function () {
      const { config } = await loadFixture(deployVaultFixture);
      const OrionTransparentVault = await ethers.getContractFactory("OrionTransparentVault");
      const vault = await OrionTransparentVault.deploy();
      await vault.waitForDeployment();
      await expect(
        vault.initialize(ethers.ZeroAddress, await config.getAddress(), "Test Vault", "TV"),
      ).to.be.revertedWithCustomError(vault, "InvalidCuratorAddress");
    });
    it("Should revert if initialized with zero config address", async function () {
      const { curator } = await loadFixture(deployVaultFixture);
      const OrionTransparentVault = await ethers.getContractFactory("OrionTransparentVault");
      const vault = await OrionTransparentVault.deploy();
      await vault.waitForDeployment();
      await expect(
        vault.initialize(curator.address, ethers.ZeroAddress, "Test Vault", "TV"),
      ).to.be.revertedWithCustomError(vault, "InvalidConfigAddress");
    });
  });

  describe("Access Control", function () {
    it("Should only allow curator to submit order intents", async function () {
      const { vault, unauthorized } = await loadFixture(deployVaultFixture);
      const order = [{ token: ethers.ZeroAddress, value: 1000000 }];
      await expect(vault.connect(unauthorized).submitIntent(order)).to.be.revertedWithCustomError(vault, "NotCurator");
    });
    it("Should only allow liquidity orchestrator to update vault state", async function () {
      const { vault, unauthorized } = await loadFixture(deployVaultFixture);
      const portfolio = [{ token: ethers.ZeroAddress, value: 1000000 }];
      await expect(
        vault.connect(unauthorized).updateVaultState(portfolio, ethers.parseUnits("1.1", 6)),
      ).to.be.revertedWithCustomError(vault, "NotLiquidityOrchestrator");
    });
    it("Should only allow liquidity orchestrator to process deposit requests", async function () {
      const { vault, unauthorized } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(unauthorized).processDepositRequests()).to.be.revertedWithCustomError(
        vault,
        "NotLiquidityOrchestrator",
      );
    });
    it("Should only allow liquidity orchestrator to process withdrawal requests", async function () {
      const { vault, unauthorized } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(unauthorized).processWithdrawRequests()).to.be.revertedWithCustomError(
        vault,
        "NotLiquidityOrchestrator",
      );
    });
  });

  describe("Synchronous Operations (Disabled)", function () {
    it("Should revert direct deposits", async function () {
      const { vault, lp1 } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(lp1).deposit(ethers.parseUnits("100", 6), lp1.address)).to.be.revertedWithCustomError(
        vault,
        "SynchronousCallDisabled",
      );
    });
    it("Should revert direct mints", async function () {
      const { vault, lp1 } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(lp1).mint(ethers.parseUnits("100", 6), lp1.address)).to.be.revertedWithCustomError(
        vault,
        "SynchronousCallDisabled",
      );
    });
    it("Should revert direct withdrawals", async function () {
      const { vault, lp1 } = await loadFixture(deployVaultFixture);
      await expect(
        vault.connect(lp1).withdraw(ethers.parseUnits("100", 6), lp1.address, lp1.address),
      ).to.be.revertedWithCustomError(vault, "SynchronousCallDisabled");
    });
    it("Should revert direct redemptions", async function () {
      const { vault, lp1 } = await loadFixture(deployVaultFixture);
      await expect(
        vault.connect(lp1).redeem(ethers.parseUnits("100", 6), lp1.address, lp1.address),
      ).to.be.revertedWithCustomError(vault, "SynchronousCallDisabled");
    });
  });

  describe("Deposit Requests", function () {
    it("Should allow LP to request deposit", async function () {
      const { vault, underlyingAsset, lp1 } = await loadFixture(deployVaultFixture);
      const depositAmount = ethers.parseUnits("100", 6);
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await expect(vault.connect(lp1).requestDeposit(depositAmount))
        .to.emit(vault, "DepositRequested")
        .withArgs(lp1.address, depositAmount);
      expect(await vault.getPendingDeposits()).to.equal(depositAmount);
    });
    it("Should revert deposit request with zero amount", async function () {
      const { vault, lp1 } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(lp1).requestDeposit(0)).to.be.revertedWithCustomError(
        vault,
        "AmountMustBeGreaterThanZero",
      );
    });
    it("Should allow multiple deposit requests from same user", async function () {
      const { vault, underlyingAsset, lp1 } = await loadFixture(deployVaultFixture);
      const depositAmount1 = ethers.parseUnits("100", 6);
      const depositAmount2 = ethers.parseUnits("50", 6);
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount1 + depositAmount2);
      await vault.connect(lp1).requestDeposit(depositAmount1);
      await vault.connect(lp1).requestDeposit(depositAmount2);
      expect(await vault.getPendingDeposits()).to.equal(depositAmount1 + depositAmount2);
    });
    it("Should revert withdrawal of non-existent deposit request", async function () {
      const { vault, lp1 } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(lp1).cancelDepositRequest(ethers.parseUnits("100", 6))).to.be.revertedWithCustomError(
        vault,
        "NotEnoughDepositRequest",
      );
    });
    it("Should revert withdrawal of more than requested", async function () {
      const { vault, underlyingAsset, lp1 } = await loadFixture(deployVaultFixture);
      const depositAmount = ethers.parseUnits("100", 6);
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(lp1).requestDeposit(depositAmount);
      await expect(vault.connect(lp1).cancelDepositRequest(ethers.parseUnits("150", 6))).to.be.revertedWithCustomError(
        vault,
        "NotEnoughDepositRequest",
      );
    });
    it("Should successfully cancel deposit request and emit DepositRequestCancelled event", async function () {
      const { vault, underlyingAsset, lp1 } = await loadFixture(deployVaultFixture);
      const depositAmount = ethers.parseUnits("100", 6);
      const cancelAmount = ethers.parseUnits("60", 6);

      // First make a deposit request
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(lp1).requestDeposit(depositAmount);

      // Then cancel part of it
      await expect(vault.connect(lp1).cancelDepositRequest(cancelAmount))
        .to.emit(vault, "DepositRequestCancelled")
        .withArgs(lp1.address, cancelAmount);

      // Verify the remaining pending deposit is correct
      const expectedRemaining = depositAmount - cancelAmount;
      expect(await vault.getPendingDeposits()).to.equal(expectedRemaining);
    });
  });

  describe("Withdrawal Requests", function () {
    it("Should allow LP to request withdrawal", async function () {
      const { vault, underlyingAsset, lp1, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);
      const depositAmount = ethers.parseUnits("100", 6);
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(lp1).requestDeposit(depositAmount);

      // Impersonate the liquidity orchestrator contract to call vault functions
      await impersonateAccount(liquidityOrchestratorAddress);
      await setBalance(liquidityOrchestratorAddress, ethers.parseEther("1"));
      const impersonatedLiquidityOrchestrator = await ethers.getSigner(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator).processDepositRequests();
      const shares = ethers.parseUnits("100", 6);
      await vault.connect(lp1).approve(await vault.getAddress(), shares);
      await expect(vault.connect(lp1).requestWithdraw(shares))
        .to.emit(vault, "WithdrawRequested")
        .withArgs(lp1.address, shares);
      expect(await vault.getPendingWithdrawals()).to.equal(shares);
    });
    it("Should revert withdrawal request with zero shares", async function () {
      const { vault, lp1 } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(lp1).requestWithdraw(0)).to.be.revertedWithCustomError(
        vault,
        "SharesMustBeGreaterThanZero",
      );
    });
    it("Should revert withdrawal request with insufficient shares", async function () {
      const { vault, lp1 } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(lp1).requestWithdraw(ethers.parseUnits("100", 6))).to.be.revertedWithCustomError(
        vault,
        "InsufficientFunds",
      );
    });
    it("Should allow multiple withdrawal requests from same user", async function () {
      const { vault, underlyingAsset, lp1, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);
      const depositAmount = ethers.parseUnits("200", 6);
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(lp1).requestDeposit(depositAmount);

      // Impersonate the liquidity orchestrator contract to call vault functions
      await impersonateAccount(liquidityOrchestratorAddress);
      await setBalance(liquidityOrchestratorAddress, ethers.parseEther("1"));
      const impersonatedLiquidityOrchestrator = await ethers.getSigner(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator).processDepositRequests();
      const shares1 = ethers.parseUnits("50", 6);
      const shares2 = ethers.parseUnits("30", 6);
      await vault.connect(lp1).approve(await vault.getAddress(), shares1 + shares2);
      await vault.connect(lp1).requestWithdraw(shares1);
      await vault.connect(lp1).requestWithdraw(shares2);
      expect(await vault.getPendingWithdrawals()).to.equal(shares1 + shares2);
    });
    it("Should revert cancellation of non-existent withdrawal request", async function () {
      const { vault, lp1 } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(lp1).cancelWithdrawRequest(ethers.parseUnits("100", 6))).to.be.revertedWithCustomError(
        vault,
        "NotEnoughWithdrawRequest",
      );
    });
    it("Should revert cancellation of more shares than requested", async function () {
      const { vault, underlyingAsset, lp1, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);
      const depositAmount = ethers.parseUnits("100", 6);

      // First make a deposit and process it to get shares
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(lp1).requestDeposit(depositAmount);

      // Impersonate the liquidity orchestrator contract to call vault functions
      await impersonateAccount(liquidityOrchestratorAddress);
      await setBalance(liquidityOrchestratorAddress, ethers.parseEther("1"));
      const impersonatedLiquidityOrchestrator = await ethers.getSigner(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator).processDepositRequests();

      // Request withdrawal of shares
      const withdrawShares = ethers.parseUnits("50", 6);
      await vault.connect(lp1).approve(await vault.getAddress(), withdrawShares);
      await vault.connect(lp1).requestWithdraw(withdrawShares);

      // Try to cancel more shares than requested
      await expect(vault.connect(lp1).cancelWithdrawRequest(ethers.parseUnits("75", 6))).to.be.revertedWithCustomError(
        vault,
        "NotEnoughWithdrawRequest",
      );
    });
    it("Should successfully cancel withdrawal request and emit WithdrawRequestCancelled event", async function () {
      const { vault, underlyingAsset, lp1, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);
      const depositAmount = ethers.parseUnits("200", 6);

      // First make a deposit and process it to get shares
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(lp1).requestDeposit(depositAmount);

      // Impersonate the liquidity orchestrator contract to call vault functions
      await impersonateAccount(liquidityOrchestratorAddress);
      await setBalance(liquidityOrchestratorAddress, ethers.parseEther("1"));
      const impersonatedLiquidityOrchestrator = await ethers.getSigner(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator).processDepositRequests();

      // Request withdrawal of shares
      const withdrawShares = ethers.parseUnits("100", 6);
      await vault.connect(lp1).approve(await vault.getAddress(), withdrawShares);
      await vault.connect(lp1).requestWithdraw(withdrawShares);

      // Cancel part of the withdrawal request
      const cancelShares = ethers.parseUnits("30", 6);
      await expect(vault.connect(lp1).cancelWithdrawRequest(cancelShares))
        .to.emit(vault, "WithdrawRequestCancelled")
        .withArgs(lp1.address, cancelShares);

      // Verify the remaining pending withdrawal is correct
      const expectedRemaining = withdrawShares - cancelShares;
      expect(await vault.getPendingWithdrawals()).to.equal(expectedRemaining);
    });
  });

  describe("Curator Functions", function () {
    it("Should allow curator to submit order intent", async function () {
      const { vault, curator, config } = await loadFixture(deployVaultFixture);
      const tokenAddress = ethers.Wallet.createRandom().address;
      // Deploy mock price adapter
      const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
      const priceAdapter = await MockPriceAdapterFactory.deploy();
      await priceAdapter.waitForDeployment();

      // Deploy ERC4626ExecutionAdapter
      const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
      const executionAdapter = await ERC4626ExecutionAdapterFactory.deploy();
      await executionAdapter.waitForDeployment();

      // Initialize mock price adapter
      await priceAdapter.initialize(curator.address);

      // Initialize ERC4626ExecutionAdapter
      await executionAdapter.initialize(curator.address);

      await config.addWhitelistedAsset(
        tokenAddress,
        await priceAdapter.getAddress(),
        await executionAdapter.getAddress(),
      );
      const order = [{ token: tokenAddress, value: 1000000 }];
      await expect(vault.connect(curator).submitIntent(order))
        .to.emit(vault, "OrderSubmitted")
        .withArgs(curator.address);
    });
    it("Should revert empty order intent", async function () {
      const { vault, curator } = await loadFixture(deployVaultFixture);
      const order: { token: string; value: number }[] = [];
      await expect(vault.connect(curator).submitIntent(order)).to.be.revertedWithCustomError(
        vault,
        "OrderIntentCannotBeEmpty",
      );
    });
    it("Should revert order with non-whitelisted token", async function () {
      const { vault, curator } = await loadFixture(deployVaultFixture);
      const nonWhitelistedToken = ethers.Wallet.createRandom().address;
      const order = [{ token: nonWhitelistedToken, value: 1000000 }];
      await expect(vault.connect(curator).submitIntent(order)).to.be.revertedWithCustomError(
        vault,
        "TokenNotWhitelisted",
      );
    });
    it("Should revert order with zero amount", async function () {
      const { vault, curator, config } = await loadFixture(deployVaultFixture);
      const tokenAddress = ethers.Wallet.createRandom().address;
      // Deploy mock price adapter
      const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
      const priceAdapter = await MockPriceAdapterFactory.deploy();
      await priceAdapter.waitForDeployment();

      // Deploy ERC4626ExecutionAdapter
      const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
      const executionAdapter = await ERC4626ExecutionAdapterFactory.deploy();
      await executionAdapter.waitForDeployment();

      // Initialize mock price adapter
      await priceAdapter.initialize(curator.address);

      // Initialize ERC4626ExecutionAdapter
      await executionAdapter.initialize(curator.address);

      await config.addWhitelistedAsset(
        tokenAddress,
        await priceAdapter.getAddress(),
        await executionAdapter.getAddress(),
      );
      const order = [{ token: tokenAddress, value: 0 }];
      await expect(vault.connect(curator).submitIntent(order)).to.be.revertedWithCustomError(
        vault,
        "AmountMustBeGreaterThanZero",
      );
    });
    it("Should revert when the same token appears twice in the order", async () => {
      const { vault, curator, config } = await loadFixture(deployVaultFixture);

      const tokenAddress = ethers.Wallet.createRandom().address;
      // Deploy mock price adapter
      const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
      const priceAdapter = await MockPriceAdapterFactory.deploy();
      await priceAdapter.waitForDeployment();

      // Deploy ERC4626ExecutionAdapter
      const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
      const executionAdapter = await ERC4626ExecutionAdapterFactory.deploy();
      await executionAdapter.waitForDeployment();

      // Initialize mock price adapter
      await priceAdapter.initialize(curator.address);

      // Initialize ERC4626ExecutionAdapter
      await executionAdapter.initialize(curator.address);

      await config.addWhitelistedAsset(
        tokenAddress,
        await priceAdapter.getAddress(),
        await executionAdapter.getAddress(),
      );

      // same token duplicated on purpose
      const duplicated = [
        { token: tokenAddress, value: 500_000 },
        { token: tokenAddress, value: 500_000 },
      ];

      await expect(vault.connect(curator).submitIntent(duplicated)).to.be.revertedWithCustomError(
        vault,
        "TokenAlreadyInOrder",
      );
    });
    it("Should revert order with invalid total amount", async function () {
      const { vault, curator, config } = await loadFixture(deployVaultFixture);
      const tokenAddress = ethers.Wallet.createRandom().address;
      // Deploy mock price adapter
      const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
      const priceAdapter = await MockPriceAdapterFactory.deploy();
      await priceAdapter.waitForDeployment();

      // Deploy ERC4626ExecutionAdapter
      const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
      const executionAdapter = await ERC4626ExecutionAdapterFactory.deploy();
      await executionAdapter.waitForDeployment();

      // Initialize mock price adapter
      await priceAdapter.initialize(curator.address);

      // Initialize ERC4626ExecutionAdapter
      await executionAdapter.initialize(curator.address);

      await config.addWhitelistedAsset(
        tokenAddress,
        await priceAdapter.getAddress(),
        await executionAdapter.getAddress(),
      );
      const order = [{ token: tokenAddress, value: 500000 }];
      await expect(vault.connect(curator).submitIntent(order)).to.be.revertedWithCustomError(
        vault,
        "InvalidTotalWeight",
      );
    });
  });

  describe("Portfolio and Intent View Functions", function () {
    it("Should return empty portfolio initially", async function () {
      const { vault } = await loadFixture(deployVaultFixture);
      const [tokens, sharesPerAsset] = await vault.getPortfolio();
      expect(tokens.length).to.equal(0);
      expect(sharesPerAsset.length).to.equal(0);
    });

    it("Should return empty intent initially", async function () {
      const { vault } = await loadFixture(deployVaultFixture);
      const [tokens, weights] = await vault.getIntent();
      expect(tokens.length).to.equal(0);
      expect(weights.length).to.equal(0);
    });

    it("Should return correct intent after curator submits order", async function () {
      const { vault, curator, config } = await loadFixture(deployVaultFixture);

      // Add whitelisted tokens
      const token1 = ethers.Wallet.createRandom().address;
      const token2 = ethers.Wallet.createRandom().address;
      // Deploy mock price adapter
      const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
      const priceAdapter = await MockPriceAdapterFactory.deploy();
      await priceAdapter.waitForDeployment();

      // Deploy ERC4626ExecutionAdapter
      const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
      const executionAdapter = await ERC4626ExecutionAdapterFactory.deploy();
      await executionAdapter.waitForDeployment();

      // Initialize mock price adapter
      await priceAdapter.initialize(curator.address);

      // Initialize ERC4626ExecutionAdapter
      await executionAdapter.initialize(curator.address);

      await config.addWhitelistedAsset(token1, await priceAdapter.getAddress(), await executionAdapter.getAddress());
      await config.addWhitelistedAsset(token2, await priceAdapter.getAddress(), await executionAdapter.getAddress());

      // Submit intent
      const order = [
        { token: token1, value: 600000 },
        { token: token2, value: 400000 },
      ];
      await vault.connect(curator).submitIntent(order);

      // Get intent and verify
      const [tokens, weights] = await vault.getIntent();
      expect(tokens.length).to.equal(2);
      expect(weights.length).to.equal(2);

      // Check that both tokens are included (order might be different)
      expect(tokens).to.include(token1);
      expect(tokens).to.include(token2);

      // Find indices and check weights
      const token1Index = tokens.indexOf(token1);
      const token2Index = tokens.indexOf(token2);
      expect(weights[token1Index]).to.equal(600000);
      expect(weights[token2Index]).to.equal(400000);
    });

    it("Should return correct portfolio after liquidity orchestrator updates state", async function () {
      const { vault, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);

      // Create portfolio update
      const token1 = ethers.Wallet.createRandom().address;
      const token2 = ethers.Wallet.createRandom().address;
      const portfolio = [
        { token: token1, value: 750000 },
        { token: token2, value: 250000 },
      ];
      const totalAssets = ethers.parseUnits("1000", 6);

      // Impersonate the liquidity orchestrator contract to call vault functions
      await impersonateAccount(liquidityOrchestratorAddress);
      await setBalance(liquidityOrchestratorAddress, ethers.parseEther("1"));
      const impersonatedLiquidityOrchestrator = await ethers.getSigner(liquidityOrchestratorAddress);

      // Update vault state
      await vault.connect(impersonatedLiquidityOrchestrator).updateVaultState(portfolio, totalAssets);

      // Get portfolio and verify
      const [tokens, sharesPerAsset] = await vault.getPortfolio();
      expect(tokens.length).to.equal(2);
      expect(sharesPerAsset.length).to.equal(2);

      // Check that both tokens are included
      expect(tokens).to.include(token1);
      expect(tokens).to.include(token2);

      // Find indices and check shares
      const token1Index = tokens.indexOf(token1);
      const token2Index = tokens.indexOf(token2);
      expect(sharesPerAsset[token1Index]).to.equal(750000);
      expect(sharesPerAsset[token2Index]).to.equal(250000);
    });

    it("Should handle single token intent", async function () {
      const { vault, curator, config } = await loadFixture(deployVaultFixture);

      const token = ethers.Wallet.createRandom().address;
      // Deploy mock price adapter
      const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
      const priceAdapter = await MockPriceAdapterFactory.deploy();
      await priceAdapter.waitForDeployment();

      // Deploy ERC4626ExecutionAdapter
      const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
      const executionAdapter = await ERC4626ExecutionAdapterFactory.deploy();
      await executionAdapter.waitForDeployment();

      // Initialize mock price adapter
      await priceAdapter.initialize(curator.address);

      // Initialize ERC4626ExecutionAdapter
      await executionAdapter.initialize(curator.address);

      await config.addWhitelistedAsset(token, await priceAdapter.getAddress(), await executionAdapter.getAddress());

      const order = [{ token: token, value: 1000000 }];
      await vault.connect(curator).submitIntent(order);

      const [tokens, weights] = await vault.getIntent();
      expect(tokens.length).to.equal(1);
      expect(weights.length).to.equal(1);
      expect(tokens[0]).to.equal(token);
      expect(weights[0]).to.equal(1000000);
    });

    it("Should handle single token portfolio", async function () {
      const { vault, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);

      const token = ethers.Wallet.createRandom().address;
      const portfolio = [{ token: token, value: 1000000 }];
      const totalAssets = ethers.parseUnits("500", 6);

      // Impersonate the liquidity orchestrator contract to call vault functions
      await impersonateAccount(liquidityOrchestratorAddress);
      await setBalance(liquidityOrchestratorAddress, ethers.parseEther("1"));
      const impersonatedLiquidityOrchestrator = await ethers.getSigner(liquidityOrchestratorAddress);

      await vault.connect(impersonatedLiquidityOrchestrator).updateVaultState(portfolio, totalAssets);

      const [tokens, sharesPerAsset] = await vault.getPortfolio();
      expect(tokens.length).to.equal(1);
      expect(sharesPerAsset.length).to.equal(1);
      expect(tokens[0]).to.equal(token);
      expect(sharesPerAsset[0]).to.equal(1000000);
    });

    it("Should clear previous intent when new intent is submitted", async function () {
      const { vault, curator, config } = await loadFixture(deployVaultFixture);

      // Add whitelisted tokens
      const token1 = ethers.Wallet.createRandom().address;
      const token2 = ethers.Wallet.createRandom().address;
      const token3 = ethers.Wallet.createRandom().address;
      // Deploy mock price adapter
      const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
      const priceAdapter = await MockPriceAdapterFactory.deploy();
      await priceAdapter.waitForDeployment();

      // Deploy ERC4626ExecutionAdapter
      const ERC4626ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
      const executionAdapter = await ERC4626ExecutionAdapterFactory.deploy();
      await executionAdapter.waitForDeployment();

      // Initialize mock price adapter
      await priceAdapter.initialize(curator.address);

      // Initialize ERC4626ExecutionAdapter
      await executionAdapter.initialize(curator.address);

      await config.addWhitelistedAsset(token1, await priceAdapter.getAddress(), await executionAdapter.getAddress());
      await config.addWhitelistedAsset(token2, await priceAdapter.getAddress(), await executionAdapter.getAddress());
      await config.addWhitelistedAsset(token3, await priceAdapter.getAddress(), await executionAdapter.getAddress());

      // Submit first intent
      const order1 = [
        { token: token1, value: 500000 },
        { token: token2, value: 500000 },
      ];
      await vault.connect(curator).submitIntent(order1);

      // Submit second intent with different tokens
      const order2 = [{ token: token3, value: 1000000 }];
      await vault.connect(curator).submitIntent(order2);

      // Verify only the new intent is returned
      const [tokens, weights] = await vault.getIntent();
      expect(tokens.length).to.equal(1);
      expect(weights.length).to.equal(1);
      expect(tokens[0]).to.equal(token3);
      expect(weights[0]).to.equal(1000000);
    });

    it("Should clear previous portfolio when new portfolio is updated", async function () {
      const { vault, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);

      // Impersonate the liquidity orchestrator contract to call vault functions
      await impersonateAccount(liquidityOrchestratorAddress);
      await setBalance(liquidityOrchestratorAddress, ethers.parseEther("1"));
      const impersonatedLiquidityOrchestrator = await ethers.getSigner(liquidityOrchestratorAddress);

      // First portfolio update
      const token1 = ethers.Wallet.createRandom().address;
      const token2 = ethers.Wallet.createRandom().address;
      const portfolio1 = [
        { token: token1, value: 600000 },
        { token: token2, value: 400000 },
      ];
      await vault.connect(impersonatedLiquidityOrchestrator).updateVaultState(portfolio1, ethers.parseUnits("1000", 6));

      // Second portfolio update with different tokens
      const token3 = ethers.Wallet.createRandom().address;
      const portfolio2 = [{ token: token3, value: 1000000 }];
      await vault.connect(impersonatedLiquidityOrchestrator).updateVaultState(portfolio2, ethers.parseUnits("1500", 6));

      // Verify only the new portfolio is returned
      const [tokens, sharesPerAsset] = await vault.getPortfolio();
      expect(tokens.length).to.equal(1);
      expect(sharesPerAsset.length).to.equal(1);
      expect(tokens[0]).to.equal(token3);
      expect(sharesPerAsset[0]).to.equal(1000000);
    });
  });

  describe("Edge Cases and Error Handling", function () {
    it("Should handle reentrancy protection", async function () {
      const { vault, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);

      // Impersonate the liquidity orchestrator contract to call vault functions
      await impersonateAccount(liquidityOrchestratorAddress);
      await setBalance(liquidityOrchestratorAddress, ethers.parseEther("1"));
      const impersonatedLiquidityOrchestrator = await ethers.getSigner(liquidityOrchestratorAddress);

      await expect(vault.connect(impersonatedLiquidityOrchestrator).processDepositRequests()).to.not.be.reverted;
    });
    it("Should handle multiple state updates correctly", async function () {
      const { vault, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);

      // Impersonate the liquidity orchestrator contract to call vault functions
      await impersonateAccount(liquidityOrchestratorAddress);
      await setBalance(liquidityOrchestratorAddress, ethers.parseEther("1"));
      const impersonatedLiquidityOrchestrator = await ethers.getSigner(liquidityOrchestratorAddress);

      const updates = [
        {
          totalAssets: ethers.parseUnits("1100", 6),
        },
        {
          totalAssets: ethers.parseUnits("1200", 6),
        },
        {
          totalAssets: ethers.parseUnits("900", 6),
        },
      ];
      for (const update of updates) {
        await vault.connect(impersonatedLiquidityOrchestrator).updateVaultState([], update.totalAssets);
      }
      expect(await vault.totalAssets()).to.equal(updates[2].totalAssets);
    });
    it("Should handle large numbers correctly", async function () {
      const { vault, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);

      // Impersonate the liquidity orchestrator contract to call vault functions
      await impersonateAccount(liquidityOrchestratorAddress);
      await setBalance(liquidityOrchestratorAddress, ethers.parseEther("1"));
      const impersonatedLiquidityOrchestrator = await ethers.getSigner(liquidityOrchestratorAddress);

      const largeTotalAssets = ethers.parseUnits("999999999999", 6);
      await vault.connect(impersonatedLiquidityOrchestrator).updateVaultState([], largeTotalAssets);
      expect(await vault.totalAssets()).to.equal(largeTotalAssets);
    });
  });
});
