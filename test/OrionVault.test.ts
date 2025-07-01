import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("OrionVault", function () {
  // Test fixture setup
  async function deployVaultFixture() {
    const [owner, curator, lp1, lp2, internalOrchestrator, liquidityOrchestrator, unauthorized] =
      await ethers.getSigners();

    // Deploy mock underlying asset
    const UnderlyingAssetFactory = await ethers.getContractFactory("UnderlyingAsset");
    const underlyingAsset = await UnderlyingAssetFactory.deploy();
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
    const vaultAddress = await vault.getAddress();
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
      expect(await vault.sharePrice()).to.equal(ethers.parseUnits("1", 18));
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
      const order = [{ token: ethers.ZeroAddress, amount: 1000000 }];
      await expect(vault.connect(unauthorized).submitOrderIntent(order)).to.be.revertedWithCustomError(
        vault,
        "NotCurator",
      );
    });
    it("Should only allow internal states orchestrator to update vault state", async function () {
      const { vault, unauthorized } = await loadFixture(deployVaultFixture);
      await expect(
        vault.connect(unauthorized).updateVaultState(ethers.parseUnits("1.1", 6), ethers.parseUnits("1000", 6)),
      ).to.be.revertedWithCustomError(vault, "NotInternalStatesOrchestrator");
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
        "SynchronousDepositsDisabled",
      );
    });
    it("Should revert direct mints", async function () {
      const { vault, lp1 } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(lp1).mint(ethers.parseUnits("100", 6), lp1.address)).to.be.revertedWithCustomError(
        vault,
        "SynchronousDepositsDisabled",
      );
    });
    it("Should revert direct withdrawals", async function () {
      const { vault, lp1 } = await loadFixture(deployVaultFixture);
      await expect(
        vault.connect(lp1).withdraw(ethers.parseUnits("100", 6), lp1.address, lp1.address),
      ).to.be.revertedWithCustomError(vault, "SynchronousWithdrawalsDisabled");
    });
    it("Should revert direct redemptions", async function () {
      const { vault, lp1 } = await loadFixture(deployVaultFixture);
      await expect(
        vault.connect(lp1).redeem(ethers.parseUnits("100", 6), lp1.address, lp1.address),
      ).to.be.revertedWithCustomError(vault, "SynchronousRedemptionsDisabled");
    });
  });

  describe("Deposit Requests", function () {
    it("Should allow LP to request deposit", async function () {
      const { vault, underlyingAsset, lp1 } = await loadFixture(deployVaultFixture);
      const depositAmount = ethers.parseUnits("100", 6);
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await expect(vault.connect(lp1).requestDeposit(depositAmount))
        .to.emit(vault, "DepositRequested")
        .withArgs(lp1.address, depositAmount, 1);
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
    it("Should allow LP to withdraw deposit request", async function () {
      const { vault, underlyingAsset, lp1 } = await loadFixture(deployVaultFixture);
      const depositAmount = ethers.parseUnits("100", 6);
      const withdrawAmount = ethers.parseUnits("30", 6);
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(lp1).requestDeposit(depositAmount);
      const balanceBefore = await underlyingAsset.balanceOf(lp1.address);
      await expect(vault.connect(lp1).cancelDepositRequest(withdrawAmount))
        .to.emit(vault, "DepositRequestCancelled")
        .withArgs(lp1.address, withdrawAmount, 1);
      const balanceAfter = await underlyingAsset.balanceOf(lp1.address);
      expect(balanceAfter - balanceBefore).to.equal(withdrawAmount);
      expect(await vault.getPendingDeposits()).to.equal(depositAmount - withdrawAmount);
    });
    it("Should allow LP to withdraw entire deposit request", async function () {
      const { vault, underlyingAsset, lp1 } = await loadFixture(deployVaultFixture);
      const depositAmount = ethers.parseUnits("100", 6);
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(lp1).requestDeposit(depositAmount);
      await vault.connect(lp1).cancelDepositRequest(depositAmount);
      expect(await vault.getPendingDeposits()).to.equal(0);
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
        .withArgs(lp1.address, shares, 1);
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

  describe("State Management", function () {
    it("Should allow internal states orchestrator to update vault state", async function () {
      const { vault, internalOrchestrator } = await loadFixture(deployVaultFixture);
      const newSharePrice = ethers.parseUnits("1.2", 6);
      const newTotalAssets = ethers.parseUnits("1200", 6);
      await expect(vault.connect(internalOrchestrator).updateVaultState(newSharePrice, newTotalAssets))
        .to.emit(vault, "VaultStateUpdated")
        .withArgs(newSharePrice, newTotalAssets);
      expect(await vault.sharePrice()).to.equal(newSharePrice);
      expect(await vault.totalAssets()).to.equal(newTotalAssets);
    });
    it("Should revert vault state update with zero share price", async function () {
      const { vault, internalOrchestrator } = await loadFixture(deployVaultFixture);
      await expect(
        vault.connect(internalOrchestrator).updateVaultState(0, ethers.parseUnits("1000", 6)),
      ).to.be.revertedWithCustomError(vault, "ZeroPrice");
    });
  });

  describe("Curator Functions", function () {
    it("Should allow curator to submit order intent", async function () {
      const { vault, curator, config } = await loadFixture(deployVaultFixture);
      const tokenAddress = ethers.Wallet.createRandom().address;
      await config.addWhitelistedAsset(tokenAddress);
      const order = [{ token: tokenAddress, amount: 1000000 }];
      await expect(vault.connect(curator).submitOrderIntent(order))
        .to.emit(vault, "OrderSubmitted")
        .withArgs(curator.address);
    });
    it("Should revert empty order intent", async function () {
      const { vault, curator } = await loadFixture(deployVaultFixture);
      const order: { token: string; amount: number }[] = [];
      await expect(vault.connect(curator).submitOrderIntent(order)).to.be.revertedWithCustomError(
        vault,
        "OrderIntentCannotBeEmpty",
      );
    });
    it("Should revert order with non-whitelisted token", async function () {
      const { vault, curator } = await loadFixture(deployVaultFixture);
      const nonWhitelistedToken = ethers.Wallet.createRandom().address;
      const order = [{ token: nonWhitelistedToken, amount: 1000000 }];
      await expect(vault.connect(curator).submitOrderIntent(order)).to.be.revertedWithCustomError(
        vault,
        "TokenNotWhitelisted",
      );
    });
    it("Should revert order with zero amount", async function () {
      const { vault, curator, config } = await loadFixture(deployVaultFixture);
      const tokenAddress = ethers.Wallet.createRandom().address;
      await config.addWhitelistedAsset(tokenAddress);
      const order = [{ token: tokenAddress, amount: 0 }];
      await expect(vault.connect(curator).submitOrderIntent(order)).to.be.revertedWithCustomError(
        vault,
        "AmountMustBeGreaterThanZero",
      );
    });
    it("Should revert order with invalid total amount", async function () {
      const { vault, curator, config } = await loadFixture(deployVaultFixture);
      const tokenAddress = ethers.Wallet.createRandom().address;
      await config.addWhitelistedAsset(tokenAddress);
      const order = [{ token: tokenAddress, amount: 500000 }];
      await expect(vault.connect(curator).submitOrderIntent(order)).to.be.revertedWithCustomError(
        vault,
        "InvalidTotalAmount",
      );
    });
  });

  describe("Edge Cases and Error Handling", function () {
    it("Should handle reentrancy protection", async function () {
      const { vault, liquidityOrchestrator } = await loadFixture(deployVaultFixture);
      await expect(vault.connect(liquidityOrchestrator).processDepositRequests()).to.not.be.reverted;
    });
    it("Should handle multiple state updates correctly", async function () {
      const { vault, internalOrchestrator } = await loadFixture(deployVaultFixture);
      const updates = [
        {
          sharePrice: ethers.parseUnits("1.1", 6),
          totalAssets: ethers.parseUnits("1100", 6),
        },
        {
          sharePrice: ethers.parseUnits("1.2", 6),
          totalAssets: ethers.parseUnits("1200", 6),
        },
        {
          sharePrice: ethers.parseUnits("0.9", 6),
          totalAssets: ethers.parseUnits("900", 6),
        },
      ];
      for (const update of updates) {
        await vault.connect(internalOrchestrator).updateVaultState(update.sharePrice, update.totalAssets);
      }
      expect(await vault.sharePrice()).to.equal(updates[2].sharePrice);
      expect(await vault.totalAssets()).to.equal(updates[2].totalAssets);
    });
    it("Should handle large numbers correctly", async function () {
      const { vault, internalOrchestrator } = await loadFixture(deployVaultFixture);
      const largeSharePrice = ethers.parseUnits("999999.999999", 6);
      const largeTotalAssets = ethers.parseUnits("999999999999", 6);
      await vault.connect(internalOrchestrator).updateVaultState(largeSharePrice, largeTotalAssets);
      expect(await vault.sharePrice()).to.equal(largeSharePrice);
      expect(await vault.totalAssets()).to.equal(largeTotalAssets);
    });
  });
});
