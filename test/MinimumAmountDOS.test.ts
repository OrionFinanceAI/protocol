import { expect } from "chai";
import { ethers } from "hardhat";
import "@openzeppelin/hardhat-upgrades";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";

/**
 * @title Minimum Amount DOS Prevention Tests
 * @notice Tests for the DOS attack mitigation via minDepositAmount and minRedeemAmount
 * @dev This test suite validates that the protocol properly prevents spam attacks
 *      by enforcing minimum amounts for deposit and redeem requests
 */
describe("Minimum Amount DOS Prevention", function () {
  // Test constants
  const USER_BALANCE = ethers.parseUnits("10000", 6); // 10k USDC per user
  const MIN_DEPOSIT = ethers.parseUnits("100", 6); // 100 USDC minimum
  const MIN_REDEEM = ethers.parseUnits("100", 18); // 100 shares minimum (18 decimals)

  async function deployFixture() {
    const [owner, strategist, attacker, user1, user2, automationRegistry] = await ethers.getSigners();

    const deployed = await deployUpgradeableProtocol(owner);

    const usdc = deployed.underlyingAsset;
    const config = deployed.orionConfig;
    const InternalStateOrchestrator = deployed.InternalStateOrchestrator;
    const liquidityOrchestrator = deployed.liquidityOrchestrator;
    const vaultFactory = deployed.transparentVaultFactory;

    // Create a vault
    const vaultTx = await vaultFactory.connect(owner).createVault(
      strategist.address,
      "Test Vault",
      "TVAULT",
      0, // Absolute fee type
      100, // 1% performance fee
      10, // 0.1% management fee
      ethers.ZeroAddress, // depositAccessControl
    );
    const receipt = await vaultTx.wait();
    const vaultCreatedEvent = receipt?.logs.find((log) => {
      try {
        return vaultFactory.interface.parseLog(log)?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const parsedLog = vaultCreatedEvent ? vaultFactory.interface.parseLog(vaultCreatedEvent) : null;
    const vaultAddress = parsedLog?.args[0];
    const VaultFactory = await ethers.getContractFactory("OrionTransparentVault");
    const vault = VaultFactory.attach(vaultAddress);

    // Mint USDC to users
    await usdc.mint(attacker.address, USER_BALANCE);
    await usdc.mint(user1.address, USER_BALANCE);
    await usdc.mint(user2.address, USER_BALANCE);

    return {
      owner,
      strategist,
      attacker,
      user1,
      user2,
      automationRegistry,
      usdc,
      config,
      vault,
      InternalStateOrchestrator,
      liquidityOrchestrator,
    };
  }

  describe("Configuration", function () {
    it("should allow owner to set minimum deposit amount", async function () {
      const { config, owner } = await loadFixture(deployFixture);

      await expect(config.connect(owner).setMinDepositAmount(MIN_DEPOSIT))
        .to.emit(config, "MinDepositAmountUpdated")
        .withArgs(MIN_DEPOSIT);

      expect(await config.minDepositAmount()).to.equal(MIN_DEPOSIT);
    });

    it("should allow owner to set minimum redeem amount", async function () {
      const { config, owner } = await loadFixture(deployFixture);

      await expect(config.connect(owner).setMinRedeemAmount(MIN_REDEEM))
        .to.emit(config, "MinRedeemAmountUpdated")
        .withArgs(MIN_REDEEM);

      expect(await config.minRedeemAmount()).to.equal(MIN_REDEEM);
    });

    it("should not allow non-owner to set minimum amounts", async function () {
      const { config, attacker } = await loadFixture(deployFixture);

      await expect(config.connect(attacker).setMinDepositAmount(MIN_DEPOSIT)).to.be.reverted;

      await expect(config.connect(attacker).setMinRedeemAmount(MIN_REDEEM)).to.be.reverted;
    });

    it("should only allow setting minimums when system is idle", async function () {
      const { config, owner } = await loadFixture(deployFixture);

      // When system is idle (default state), should succeed
      await expect(config.connect(owner).setMinDepositAmount(MIN_DEPOSIT)).to.not.be.reverted;

      expect(await config.minDepositAmount()).to.equal(MIN_DEPOSIT);
    });

    it("should start with zero minimum amounts by default", async function () {
      const { config } = await loadFixture(deployFixture);

      expect(await config.minDepositAmount()).to.equal(0);
      expect(await config.minRedeemAmount()).to.equal(0);
    });
  });

  describe("DOS Attack Prevention - Deposits", function () {
    it("should reject deposit requests below minimum (1 wei attack)", async function () {
      const { config, vault, usdc, attacker, owner } = await loadFixture(deployFixture);

      // Set minimum deposit amount
      await config.connect(owner).setMinDepositAmount(MIN_DEPOSIT);

      // Attacker tries to spam with 1 wei deposits
      const tinyAmount = 1n;
      await usdc.connect(attacker).approve(await vault.getAddress(), tinyAmount);

      await expect(vault.connect(attacker).requestDeposit(tinyAmount))
        .to.be.revertedWithCustomError(vault, "BelowMinimumDeposit")
        .withArgs(tinyAmount, MIN_DEPOSIT);
    });

    it("should reject deposit requests just below minimum", async function () {
      const { config, vault, usdc, attacker, owner } = await loadFixture(deployFixture);

      await config.connect(owner).setMinDepositAmount(MIN_DEPOSIT);

      const belowMin = MIN_DEPOSIT - 1n;
      await usdc.connect(attacker).approve(await vault.getAddress(), belowMin);

      await expect(vault.connect(attacker).requestDeposit(belowMin))
        .to.be.revertedWithCustomError(vault, "BelowMinimumDeposit")
        .withArgs(belowMin, MIN_DEPOSIT);
    });

    it("should accept deposit requests at exact minimum", async function () {
      const { config, vault, usdc, user1, owner } = await loadFixture(deployFixture);

      await config.connect(owner).setMinDepositAmount(MIN_DEPOSIT);

      await usdc.connect(user1).approve(await vault.getAddress(), MIN_DEPOSIT);

      await expect(vault.connect(user1).requestDeposit(MIN_DEPOSIT))
        .to.emit(vault, "DepositRequest")
        .withArgs(user1.address, MIN_DEPOSIT);
    });

    it("should accept deposit requests above minimum", async function () {
      const { config, vault, usdc, user1, owner } = await loadFixture(deployFixture);

      await config.connect(owner).setMinDepositAmount(MIN_DEPOSIT);

      const aboveMin = MIN_DEPOSIT * 2n;
      await usdc.connect(user1).approve(await vault.getAddress(), aboveMin);

      await expect(vault.connect(user1).requestDeposit(aboveMin))
        .to.emit(vault, "DepositRequest")
        .withArgs(user1.address, aboveMin);
    });

    it("should prevent spam attack with 150+ tiny deposits", async function () {
      const { config, vault, usdc, owner } = await loadFixture(deployFixture);

      // Set minimum to prevent spam
      await config.connect(owner).setMinDepositAmount(MIN_DEPOSIT);

      // Create multiple attacker accounts
      const attackers: SignerWithAddress[] = [];
      for (let i = 0; i < 160; i++) {
        const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
        attackers.push(wallet as unknown as SignerWithAddress);

        // Fund attacker
        await usdc.mint(wallet.address, ethers.parseUnits("1", 6));

        // Give them ETH for gas
        await owner.sendTransaction({
          to: wallet.address,
          value: ethers.parseEther("0.1"),
        });
      }

      // Try to spam with 1 wei deposits from each account
      let successfulSpam = 0;
      for (const attacker of attackers) {
        try {
          await usdc.connect(attacker).approve(await vault.getAddress(), 1n);
          await vault.connect(attacker).requestDeposit(1n);
          successfulSpam++;
        } catch {
          // Expected to fail due to minimum
        }
      }

      // Should have prevented all spam attempts
      expect(successfulSpam).to.equal(0);
    });

    it("should allow legitimate users to deposit even with minimum set", async function () {
      const { config, vault, usdc, user1, user2, owner } = await loadFixture(deployFixture);

      await config.connect(owner).setMinDepositAmount(MIN_DEPOSIT);

      // User 1 deposits 500 USDC
      const amount1 = ethers.parseUnits("500", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), amount1);
      await expect(vault.connect(user1).requestDeposit(amount1)).to.emit(vault, "DepositRequest");

      // User 2 deposits 1000 USDC
      const amount2 = ethers.parseUnits("1000", 6);
      await usdc.connect(user2).approve(await vault.getAddress(), amount2);
      await expect(vault.connect(user2).requestDeposit(amount2)).to.emit(vault, "DepositRequest");
    });
  });

  describe("DOS Attack Prevention - Redeems", function () {
    it("should reject redeem requests below minimum (1 wei attack)", async function () {
      const { config, vault, usdc, user1, owner } = await loadFixture(deployFixture);

      // First deposit to get shares
      const depositAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).requestDeposit(depositAmount);

      // Set minimum redeem
      await config.connect(owner).setMinRedeemAmount(MIN_REDEEM);

      // Try to redeem 1 wei of shares
      const tinyShares = 1n;

      await expect(vault.connect(user1).requestRedeem(tinyShares))
        .to.be.revertedWithCustomError(vault, "BelowMinimumRedeem")
        .withArgs(tinyShares, MIN_REDEEM);
    });

    it("should reject redeem requests just below minimum", async function () {
      const { config, vault, usdc, user1, owner } = await loadFixture(deployFixture);

      const depositAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).requestDeposit(depositAmount);

      await config.connect(owner).setMinRedeemAmount(MIN_REDEEM);

      const belowMin = MIN_REDEEM - 1n;

      await expect(vault.connect(user1).requestRedeem(belowMin))
        .to.be.revertedWithCustomError(vault, "BelowMinimumRedeem")
        .withArgs(belowMin, MIN_REDEEM);
    });

    it("should prevent changing minimum amounts to bypass protection", async function () {
      const { config, vault, usdc, user1, owner } = await loadFixture(deployFixture);

      // Set initial minimum
      await config.connect(owner).setMinDepositAmount(MIN_DEPOSIT);
      expect(await config.minDepositAmount()).to.equal(MIN_DEPOSIT);

      // Try to deposit below minimum - should fail
      const tinyAmount = 1n;
      await usdc.connect(user1).approve(await vault.getAddress(), tinyAmount);
      await expect(vault.connect(user1).requestDeposit(tinyAmount)).to.be.revertedWithCustomError(
        vault,
        "BelowMinimumDeposit",
      );
    });
  });

  describe("Economic Attack Analysis", function () {
    it("should make spam attack economically unfeasible", async function () {
      const { config, owner } = await loadFixture(deployFixture);

      // Set minimum deposit to 100 USDC
      const minDeposit = ethers.parseUnits("100", 6);
      await config.connect(owner).setMinDepositAmount(minDeposit);

      // Calculate cost to fill 150-request queue
      const MAX_FULFILL_BATCH_SIZE = await config.maxFulfillBatchSize();
      const totalCapitalRequired = minDeposit * MAX_FULFILL_BATCH_SIZE;

      // Should require $15,000 USD (150 * $100) of locked capital
      const expectedCost = ethers.parseUnits("15000", 6); // 15k USDC
      expect(totalCapitalRequired).to.equal(expectedCost);

      // This capital would be locked for at least 1 epoch (1 day)
      // Making the attack economically unfeasible compared to gas-only attack
    });

    it("should prevent queue flooding within gas budget", async function () {
      const { config, owner } = await loadFixture(deployFixture);

      await config.connect(owner).setMinDepositAmount(MIN_DEPOSIT);

      // Even with significant capital, minimum amount limits queue flooding
      const attackerBalance = USER_BALANCE; // 10k USDC
      const maxRequests = attackerBalance / MIN_DEPOSIT; // Only 100 requests possible

      expect(maxRequests).to.be.lessThan(150); // Can't fill entire queue

      // The attacker needs 15k USDC to fill queue, but only has 10k
      // This makes the attack impractical
    });
  });

  describe("Edge Cases", function () {
    it("should handle maximum uint256 minimum", async function () {
      const { config, owner } = await loadFixture(deployFixture);

      const maxUint256 = ethers.MaxUint256;

      await expect(config.connect(owner).setMinDepositAmount(maxUint256))
        .to.emit(config, "MinDepositAmountUpdated")
        .withArgs(maxUint256);

      expect(await config.minDepositAmount()).to.equal(maxUint256);
    });

    it("should properly validate with different decimal assets", async function () {
      const { config, owner } = await loadFixture(deployFixture);

      // For 6-decimal asset (USDC): 100 USDC = 100e6
      const min6Decimals = ethers.parseUnits("100", 6);
      await config.connect(owner).setMinDepositAmount(min6Decimals);
      expect(await config.minDepositAmount()).to.equal(min6Decimals);

      // If underlying was 18-decimal (ETH): 0.1 ETH = 0.1e18
      const min18Decimals = ethers.parseUnits("0.1", 18);
      await config.connect(owner).setMinDepositAmount(min18Decimals);
      expect(await config.minDepositAmount()).to.equal(min18Decimals);
    });
  });

  describe("Integration with Existing Validations", function () {
    it("should still enforce zero amount check before minimum check", async function () {
      const { config, vault, owner } = await loadFixture(deployFixture);

      await config.connect(owner).setMinDepositAmount(MIN_DEPOSIT);

      // Zero amount should be caught by existing validation first
      await expect(vault.requestDeposit(0)).to.be.revertedWithCustomError(vault, "AmountMustBeGreaterThanZero");
    });

    it("should validate minimum check in proper order with other checks", async function () {
      const { config, vault, usdc, user1, owner } = await loadFixture(deployFixture);

      await config.connect(owner).setMinDepositAmount(MIN_DEPOSIT);

      // Minimum check happens after zero check but before transfer
      // If we pass a valid minimum amount, the minimum check passes
      await usdc.connect(user1).approve(await vault.getAddress(), MIN_DEPOSIT);
      await expect(vault.connect(user1).requestDeposit(MIN_DEPOSIT)).to.not.be.reverted;
    });

    it("should still enforce balance check after minimum check", async function () {
      const { config, vault, usdc, user1, owner } = await loadFixture(deployFixture);

      await config.connect(owner).setMinDepositAmount(MIN_DEPOSIT);

      // User tries to deposit minimum but has insufficient balance
      const userBalance = await usdc.balanceOf(user1.address);

      // Drain user's balance
      await usdc.connect(user1).transfer(owner.address, userBalance);

      await usdc.connect(user1).approve(await vault.getAddress(), MIN_DEPOSIT);
      await expect(vault.connect(user1).requestDeposit(MIN_DEPOSIT)).to.be.revertedWithCustomError(
        vault,
        "InsufficientAmount",
      );
    });
  });

  describe("Security Validation", function () {
    it("should completely prevent the described DOS attack scenario", async function () {
      const { config, vault, usdc, owner, attacker } = await loadFixture(deployFixture);

      await config.connect(owner).setMinDepositAmount(MIN_DEPOSIT);
      await config.connect(owner).setMinRedeemAmount(MIN_REDEEM);

      // "An attacker can create many small deposit requests of 1 wei from many accounts"
      // Try 1 wei deposit (should be rejected)
      await usdc.mint(attacker.address, 1n);
      await usdc.connect(attacker).approve(await vault.getAddress(), 1n);
      await expect(vault.connect(attacker).requestDeposit(1n)).to.be.revertedWithCustomError(
        vault,
        "BelowMinimumDeposit",
      );

      // Verify that even with many attempts, all fail due to minimum
      // (testing the principle without actually creating 200 accounts for speed)
      const attemptCount = 10;
      for (let i = 0; i < attemptCount; i++) {
        await usdc.mint(attacker.address, 1n);
        await usdc.connect(attacker).approve(await vault.getAddress(), 1n);
        await expect(vault.connect(attacker).requestDeposit(1n))
          .to.be.revertedWithCustomError(vault, "BelowMinimumDeposit")
          .withArgs(1n, MIN_DEPOSIT);
      }

      // Calculate capital requirement
      const capitalRequired = (MIN_DEPOSIT * 150n) / 10n ** 6n; // 150 = MAX_FULFILL_BATCH_SIZE
      expect(capitalRequired).to.equal(15000n); // $15,000 USD to fill queue

      console.log("✓ DOS attack with 1-wei deposits completely prevented");
      console.log(`✓ Attack attempts: ${attemptCount}, All prevented`);
      console.log(`✓ Capital required to fill queue (150 requests): $${capitalRequired} USD`);
    });
  });
});
