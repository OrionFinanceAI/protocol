import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("OrionTransparentVault", function () {
  // Test fixture setup
  async function deployVaultFixture() {
    const [owner, curator, lp1, lp2, internalOrchestrator, liquidityOrchestrator, unauthorized] =
      await ethers.getSigners();

    // Deploy mock underlying asset
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAsset = await MockUnderlyingAssetFactory.deploy();
    await underlyingAsset.waitForDeployment();
    const underlyingAssetAddress = await underlyingAsset.getAddress();

    // Deploy OrionConfig
    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    const config = await OrionConfigFactory.deploy();
    await config.waitForDeployment();
    const configAddress = await config.getAddress();
    await config.initialize(owner.address);

    // Set protocol parameters
    await config.setProtocolParams(
      underlyingAssetAddress,
      internalOrchestrator.address,
      liquidityOrchestrator.address,
      18, // statesDecimals
      6, // curatorIntentDecimals
      owner.address, // factory
      owner.address, // oracleRegistry
    );

    // Deploy OrionTransparentVault (concrete implementation of OrionVault)
    const OrionTransparentVaultFactory = await ethers.getContractFactory("OrionTransparentVault");
    const vault = await OrionTransparentVaultFactory.deploy();
    await vault.waitForDeployment();
    await vault.initialize(curator.address, configAddress, "Test Vault", "TV");

    // Mint some underlying assets to LPs for testing
    await underlyingAsset.mint(lp1.address, ethers.parseUnits("10000", 6));
    await underlyingAsset.mint(lp2.address, ethers.parseUnits("10000", 6));

    return {
      vault,
      config,
      underlyingAsset,
      owner,
      curator,
      lp1,
      lp2,
      internalOrchestrator,
      liquidityOrchestrator,
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
  });

  describe("Withdrawal Requests", function () {
    it("Should allow LP to request withdrawal", async function () {
      const { vault, underlyingAsset, lp1, liquidityOrchestrator } = await loadFixture(deployVaultFixture);
      const depositAmount = ethers.parseUnits("100", 6);
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(lp1).requestDeposit(depositAmount);
      await vault.connect(liquidityOrchestrator).processDepositRequests();
      const shares = ethers.parseUnits("100", 6);
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
        "NotEnoughShares",
      );
    });
    it("Should allow multiple withdrawal requests from same user", async function () {
      const { vault, underlyingAsset, lp1, liquidityOrchestrator } = await loadFixture(deployVaultFixture);
      const depositAmount = ethers.parseUnits("200", 6);
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(lp1).requestDeposit(depositAmount);
      await vault.connect(liquidityOrchestrator).processDepositRequests();
      const shares1 = ethers.parseUnits("50", 6);
      const shares2 = ethers.parseUnits("30", 6);
      await vault.connect(lp1).requestWithdraw(shares1);
      await vault.connect(lp1).requestWithdraw(shares2);
      expect(await vault.getPendingWithdrawals()).to.equal(shares1 + shares2);
    });
  });

  describe("Curator Functions", function () {
    it("Should allow curator to submit order intent", async function () {
      const { vault, curator, config } = await loadFixture(deployVaultFixture);
      const tokenAddress = ethers.Wallet.createRandom().address;
      await config.addWhitelistedAsset(tokenAddress);
      const order = [{ token: tokenAddress, value: 1000000 }];
      await expect(vault.connect(curator).submitIntent(order))
        .to.emit(vault, "OrderSubmitted")
        .withArgs(curator.address);
    });
    it("Should revert empty order intent", async function () {
      const { vault, curator } = await loadFixture(deployVaultFixture);
      const order: { token: string; amount: number }[] = [];
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
      await config.addWhitelistedAsset(tokenAddress);
      const order = [{ token: tokenAddress, value: 0 }];
      await expect(vault.connect(curator).submitIntent(order)).to.be.revertedWithCustomError(
        vault,
        "AmountMustBeGreaterThanZero",
      );
    });
    it("Should revert when the same token appears twice in the order", async () => {
      const { vault, curator, config } = await loadFixture(deployVaultFixture);

      const tokenAddress = ethers.Wallet.createRandom().address;
      await config.addWhitelistedAsset(tokenAddress);

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
      await config.addWhitelistedAsset(tokenAddress);
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
      await config.addWhitelistedAsset(token1);
      await config.addWhitelistedAsset(token2);

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
      const { vault, liquidityOrchestrator } = await loadFixture(deployVaultFixture);

      // Create portfolio update
      const token1 = ethers.Wallet.createRandom().address;
      const token2 = ethers.Wallet.createRandom().address;
      const portfolio = [
        { token: token1, value: 750000 },
        { token: token2, value: 250000 },
      ];
      const totalAssets = ethers.parseUnits("1000", 6);

      // Update vault state
      await vault.connect(liquidityOrchestrator).updateVaultState(portfolio, totalAssets);

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
      await config.addWhitelistedAsset(token);

      const order = [{ token: token, value: 1000000 }];
      await vault.connect(curator).submitIntent(order);

      const [tokens, weights] = await vault.getIntent();
      expect(tokens.length).to.equal(1);
      expect(weights.length).to.equal(1);
      expect(tokens[0]).to.equal(token);
      expect(weights[0]).to.equal(1000000);
    });

    it("Should handle single token portfolio", async function () {
      const { vault, liquidityOrchestrator } = await loadFixture(deployVaultFixture);

      const token = ethers.Wallet.createRandom().address;
      const portfolio = [{ token: token, value: 1000000 }];
      const totalAssets = ethers.parseUnits("500", 6);

      await vault.connect(liquidityOrchestrator).updateVaultState(portfolio, totalAssets);

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
      await config.addWhitelistedAsset(token1);
      await config.addWhitelistedAsset(token2);
      await config.addWhitelistedAsset(token3);

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
      const { vault, liquidityOrchestrator } = await loadFixture(deployVaultFixture);

      // First portfolio update
      const token1 = ethers.Wallet.createRandom().address;
      const token2 = ethers.Wallet.createRandom().address;
      const portfolio1 = [
        { token: token1, value: 600000 },
        { token: token2, value: 400000 },
      ];
      await vault.connect(liquidityOrchestrator).updateVaultState(portfolio1, ethers.parseUnits("1000", 6));

      // Second portfolio update with different tokens
      const token3 = ethers.Wallet.createRandom().address;
      const portfolio2 = [{ token: token3, value: 1000000 }];
      await vault.connect(liquidityOrchestrator).updateVaultState(portfolio2, ethers.parseUnits("1500", 6));

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
      const { vault, liquidityOrchestrator } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(liquidityOrchestrator).processDepositRequests()).to.not.be.reverted;
    });
    it("Should handle multiple state updates correctly", async function () {
      const { vault, liquidityOrchestrator } = await loadFixture(deployVaultFixture);
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
        await vault.connect(liquidityOrchestrator).updateVaultState([], update.totalAssets);
      }
      expect(await vault.totalAssets()).to.equal(updates[2].totalAssets);
    });
    it("Should handle large numbers correctly", async function () {
      const { vault, liquidityOrchestrator } = await loadFixture(deployVaultFixture);
      const largeTotalAssets = ethers.parseUnits("999999999999", 6);
      await vault.connect(liquidityOrchestrator).updateVaultState([], largeTotalAssets);
      expect(await vault.totalAssets()).to.equal(largeTotalAssets);
    });
  });
});
