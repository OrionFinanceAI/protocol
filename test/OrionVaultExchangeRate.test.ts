import { impersonateAccount, loadFixture, setBalance } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";

describe("OrionVault Exchange Rate Tests", function () {
  // Helper function to impersonate liquidity orchestrator
  async function impersonateLiquidityOrchestrator(liquidityOrchestratorAddress: string) {
    await impersonateAccount(liquidityOrchestratorAddress);
    await setBalance(liquidityOrchestratorAddress, ethers.parseEther("1"));
    return await ethers.getSigner(liquidityOrchestratorAddress);
  }

  // Test fixture setup
  async function deployVaultFixture() {
    const [owner, curator, lp1, lp2, lp3, liquidityOrchestratorSigner, attacker] = await ethers.getSigners();

    // Deploy mock underlying asset (6 decimals)
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAsset = await MockUnderlyingAssetFactory.deploy(6);
    await underlyingAsset.waitForDeployment();
    const underlyingAssetAddress = await underlyingAsset.getAddress();

    // Deploy OrionConfig
    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    const config = await OrionConfigFactory.deploy(owner.address, underlyingAssetAddress);
    await config.waitForDeployment();
    const configAddress = await config.getAddress();

    // Deploy PriceAdapterRegistry
    const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
    const priceAdapterRegistry = await PriceAdapterRegistryFactory.deploy(owner.address, configAddress);
    await priceAdapterRegistry.waitForDeployment();

    // Deploy InternalStatesOrchestrator
    const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
    const internalStatesOrchestrator = await InternalStatesOrchestratorFactory.deploy(
      owner.address,
      configAddress,
      liquidityOrchestratorSigner.address,
    );
    await internalStatesOrchestrator.waitForDeployment();

    // Deploy LiquidityOrchestrator
    const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
    const liquidityOrchestratorContract = await LiquidityOrchestratorFactory.deploy(
      owner.address,
      configAddress,
      liquidityOrchestratorSigner.address,
    );
    await liquidityOrchestratorContract.waitForDeployment();

    // Set orchestrators in config
    await config.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());
    await config.setLiquidityOrchestrator(await liquidityOrchestratorContract.getAddress());
    await config.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

    // Set protocol parameters
    await config.setProtocolRiskFreeRate(0.0423 * 10_000);

    // Deploy OrionTransparentVault with correct constructor parameters
    const OrionTransparentVaultFactory = await ethers.getContractFactory("OrionTransparentVault");
    const vault = await OrionTransparentVaultFactory.deploy(
      owner.address,
      curator.address,
      configAddress,
      "Test Vault",
      "TV",
      0,
      0,
      0,
    );
    await vault.waitForDeployment();

    // Mint underlying assets to all participants
    await underlyingAsset.mint(lp1.address, ethers.parseUnits("1000000000000", 6));
    await underlyingAsset.mint(lp2.address, ethers.parseUnits("1000000000000", 6));
    await underlyingAsset.mint(lp3.address, ethers.parseUnits("1000000000000", 6));
    await underlyingAsset.mint(attacker.address, ethers.parseUnits("1000000000000", 6));

    return {
      vault,
      config,
      underlyingAsset,
      owner,
      curator,
      lp1,
      lp2,
      lp3,
      internalStatesOrchestrator: internalStatesOrchestrator,
      liquidityOrchestrator: liquidityOrchestratorSigner,
      liquidityOrchestratorContract,
      liquidityOrchestratorAddress: await liquidityOrchestratorContract.getAddress(),
      attacker,
    };
  }

  describe("Initial State", function () {
    it("Should have correct initial exchange rate values", async function () {
      const { vault } = await loadFixture(deployVaultFixture);

      // Initial state: no assets, no shares
      expect(await vault.totalAssets()).to.equal(0);
      expect(await vault.totalSupply()).to.equal(0);

      // Test conversion functions with zero values
      expect(await vault.convertToShares(0)).to.equal(0);
      expect(await vault.convertToAssets(0)).to.equal(0);
    });

    it("Should handle edge cases with virtual offset", async function () {
      const { vault } = await loadFixture(deployVaultFixture);

      // Test with very small amounts
      const tinyAmount = 1;
      const tinyShares = await vault.convertToShares(tinyAmount);
      const convertedBack = await vault.convertToAssets(tinyShares);

      // Due to virtual offset, tiny amounts should still convert properly
      expect(tinyShares).to.be.gt(0);
      expect(convertedBack).to.be.gt(0);
    });
  });

  describe("Exchange Rate After Initial Deposit", function () {
    it("Should maintain 1:1 exchange rate after first deposit", async function () {
      const { vault, underlyingAsset, lp1, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseUnits("1000", 6);

      // Request deposit
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(lp1).requestDeposit(depositAmount);

      // Impersonate the liquidity orchestrator contract to call vault functions
      const impersonatedLiquidityOrchestrator = await impersonateLiquidityOrchestrator(liquidityOrchestratorAddress);

      // Process deposit
      await vault.connect(impersonatedLiquidityOrchestrator).processDepositRequests();

      // Update vault state with the new total assets
      await vault.connect(impersonatedLiquidityOrchestrator).updateVaultState([], depositAmount);

      // Check exchange rate
      const shares = await vault.balanceOf(lp1.address);
      const assets = await vault.convertToAssets(shares);

      // Should be approximately 1:1 (allowing for small rounding differences)
      expect(assets).to.be.closeTo(depositAmount, ethers.parseUnits("1", 6));
      expect(shares).to.be.gt(depositAmount);
    });

    it("Should handle multiple deposits correctly", async function () {
      const { vault, underlyingAsset, lp1, lp2, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);

      const deposit1 = ethers.parseUnits("1000", 6);
      const deposit2 = ethers.parseUnits("500", 6);

      // First deposit
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), deposit1);
      await vault.connect(lp1).requestDeposit(deposit1);
      const impersonatedLiquidityOrchestrator1 = await impersonateLiquidityOrchestrator(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator1).processDepositRequests();
      await vault.connect(impersonatedLiquidityOrchestrator1).updateVaultState([], deposit1);

      // Second deposit
      await underlyingAsset.connect(lp2).approve(await vault.getAddress(), deposit2);
      await vault.connect(lp2).requestDeposit(deposit2);
      const impersonatedLiquidityOrchestrator2 = await impersonateLiquidityOrchestrator(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator2).processDepositRequests();
      await vault.connect(impersonatedLiquidityOrchestrator2).updateVaultState([], deposit1 + deposit2);

      // Check exchange rates
      const shares1 = await vault.balanceOf(lp1.address);
      const shares2 = await vault.balanceOf(lp2.address);
      const assets1 = await vault.convertToAssets(shares1);
      const assets2 = await vault.convertToAssets(shares2);

      expect(assets1).to.be.closeTo(deposit1, ethers.parseUnits("1", 6));
      expect(assets2).to.be.closeTo(deposit2, ethers.parseUnits("1", 6));
    });
  });

  describe("Exchange Rate Consistency", function () {
    it("Should maintain consistent exchange rate for round-trip conversions", async function () {
      const { vault, underlyingAsset, lp1, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseUnits("1000", 6);

      // Setup initial deposit
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(lp1).requestDeposit(depositAmount);
      const impersonatedLiquidityOrchestrator = await impersonateLiquidityOrchestrator(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator).processDepositRequests();
      await vault.connect(impersonatedLiquidityOrchestrator).updateVaultState([], depositAmount);

      const shares = await vault.balanceOf(lp1.address);

      // Test round-trip conversions
      const assetsFromShares = await vault.convertToAssets(shares);
      const sharesFromAssets = await vault.convertToShares(assetsFromShares);

      // Should be consistent (allowing for small rounding differences)
      expect(sharesFromAssets).to.be.closeTo(shares, 1);
    });

    it("Should handle various asset amounts consistently", async function () {
      const { vault, underlyingAsset, lp1, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseUnits("1000", 6);

      // Setup initial deposit
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(lp1).requestDeposit(depositAmount);
      const impersonatedLiquidityOrchestrator = await impersonateLiquidityOrchestrator(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator).processDepositRequests();
      await vault.connect(impersonatedLiquidityOrchestrator).updateVaultState([], depositAmount);

      // Test various conversion amounts
      const testAmounts = [
        ethers.parseUnits("1", 6),
        ethers.parseUnits("10", 6),
        ethers.parseUnits("100", 6),
        ethers.parseUnits("500", 6),
        ethers.parseUnits("1000", 6),
      ];

      for (const amount of testAmounts) {
        const shares = await vault.convertToShares(amount);
        const assets = await vault.convertToAssets(shares);

        // Should be consistent within rounding tolerance
        expect(assets).to.be.closeTo(amount, ethers.parseUnits("1", 6));
      }
    });
  });

  describe("Inflation Attack Protection", function () {
    it("Should be protected against donation‑based inflation attacks", async function () {
      const { vault, underlyingAsset, lp1, attacker, liquidityOrchestratorAddress } =
        await loadFixture(deployVaultFixture);

      /* ── 1. Legitimate deposit ────────────────────────────────────────────── */
      const initialDeposit = ethers.parseUnits("1000", 6); // 1000 USDC
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), initialDeposit);

      await vault.connect(lp1).requestDeposit(initialDeposit);
      const impersonatedLiquidityOrchestrator1 = await impersonateLiquidityOrchestrator(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator1).processDepositRequests();
      await vault.connect(impersonatedLiquidityOrchestrator1).updateVaultState([], initialDeposit);

      const initialShares = await vault.balanceOf(lp1.address);
      const initialAssets = await vault.convertToAssets(initialShares);

      /* ── 2. Malicious donation ────────────────────────────────────────────── */
      const donationAmount = ethers.parseUnits("1000000000000", 6); // 1T USDC
      await underlyingAsset.connect(attacker).transfer(await vault.getAddress(), donationAmount);

      // Tell the vault the donation arrived (update total assets to include both initial deposit and donation)
      const impersonatedLiquidityOrchestrator2 = await impersonateLiquidityOrchestrator(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator2).updateVaultState([], initialDeposit + donationAmount);

      /* ── 3. Post‑donation balances ────────────────────────────────────────── */
      const sharesAfterDonation = await vault.balanceOf(lp1.address);
      const assetsAfterDonation = await vault.convertToAssets(sharesAfterDonation);

      /* ── 4. Sanity checks ────────────────────────────────────────────── */
      expect(assetsAfterDonation).to.be.gt(initialAssets);
      expect(assetsAfterDonation).to.be.lt(initialAssets + donationAmount);

      /* ── 5. Precise bound using the vault's virtual‑offset formula ───────── */
      const virtualOffset = 10n ** BigInt(18 - 6);
      const totalSupply = await vault.totalSupply();
      const totalSupplyPlusOffset = totalSupply + virtualOffset;

      // Max gain the user can ever get from this donation, per _convertToAssets math
      const expectedIncrease = (donationAmount * initialShares) / totalSupplyPlusOffset;
      const actualIncrease = assetsAfterDonation - initialAssets;

      // The actual increase should be close to the expected increase with virtual offset
      expect(actualIncrease).to.be.closeTo(expectedIncrease, ethers.parseUnits("10", 6));
    });

    it("Should maintain exchange rate stability with multiple users", async function () {
      const { vault, underlyingAsset, lp1, lp2, attacker, liquidityOrchestratorAddress } =
        await loadFixture(deployVaultFixture);

      // Multiple users deposit
      const deposit1 = ethers.parseUnits("1000", 6);
      const deposit2 = ethers.parseUnits("2000", 6);

      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), deposit1);
      await vault.connect(lp1).requestDeposit(deposit1);

      await underlyingAsset.connect(lp2).approve(await vault.getAddress(), deposit2);
      await vault.connect(lp2).requestDeposit(deposit2);

      const impersonatedLiquidityOrchestrator1 = await impersonateLiquidityOrchestrator(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator1).processDepositRequests();
      await vault.connect(impersonatedLiquidityOrchestrator1).updateVaultState([], deposit1 + deposit2);

      const shares1Before = await vault.balanceOf(lp1.address);
      const shares2Before = await vault.balanceOf(lp2.address);
      const assets1Before = await vault.convertToAssets(shares1Before);
      const assets2Before = await vault.convertToAssets(shares2Before);

      // Attacker donates
      const donation = ethers.parseUnits("5000", 6);
      await underlyingAsset.connect(attacker).transfer(await vault.getAddress(), donation);

      // Update total assets to include the donation
      const impersonatedLiquidityOrchestrator2 = await impersonateLiquidityOrchestrator(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator2).updateVaultState([], deposit1 + deposit2 + donation);

      const shares1After = await vault.balanceOf(lp1.address);
      const shares2After = await vault.balanceOf(lp2.address);
      const assets1After = await vault.convertToAssets(shares1After);
      const assets2After = await vault.convertToAssets(shares2After);

      // Both users should benefit proportionally
      const increase1 = assets1After - assets1Before;
      const increase2 = assets2After - assets2Before;

      // Proportional to their share of the total supply
      const expectedRatio = Number(shares1Before) / Number(shares2Before);
      const actualRatio = Number(increase1) / Number(increase2);

      expect(actualRatio).to.be.closeTo(expectedRatio, 0.01);
    });
  });

  describe("Virtual Offset Protection", function () {
    it("Should handle very small amounts with virtual offset", async function () {
      const { vault, underlyingAsset, lp1, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);

      // Very small initial deposit
      const tinyDeposit = 1; // 1 wei
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), tinyDeposit);
      await vault.connect(lp1).requestDeposit(tinyDeposit);
      const impersonatedLiquidityOrchestrator = await impersonateLiquidityOrchestrator(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator).processDepositRequests();
      await vault.connect(impersonatedLiquidityOrchestrator).updateVaultState([], tinyDeposit);

      const shares = await vault.balanceOf(lp1.address);
      const assets = await vault.convertToAssets(shares);

      // Should handle tiny amounts without issues
      expect(shares).to.be.gt(0);
      expect(assets).to.be.gt(0);
    });

    it("Should maintain precision with virtual offset", async function () {
      const { vault, underlyingAsset, lp1, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseUnits("1000", 6);

      // Setup initial deposit
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(lp1).requestDeposit(depositAmount);
      const impersonatedLiquidityOrchestrator = await impersonateLiquidityOrchestrator(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator).processDepositRequests();
      await vault.connect(impersonatedLiquidityOrchestrator).updateVaultState([], depositAmount);

      // Test precision with various amounts
      const testAmounts = [
        ethers.parseUnits("0.001", 6),
        ethers.parseUnits("0.01", 6),
        ethers.parseUnits("0.1", 6),
        ethers.parseUnits("1", 6),
      ];

      for (const amount of testAmounts) {
        const convertedShares = await vault.convertToShares(amount);
        const convertedAssets = await vault.convertToAssets(convertedShares);

        // Should maintain reasonable precision
        expect(convertedAssets).to.be.closeTo(amount, ethers.parseUnits("0.001", 6));
      }
    });
  });

  describe("Edge Cases and Boundary Conditions", function () {
    it("Should maintain exchange rate under stress conditions", async function () {
      const { vault, underlyingAsset, lp1, lp2, lp3, liquidityOrchestratorAddress } =
        await loadFixture(deployVaultFixture);

      // Multiple deposits and withdrawals to stress the system
      const deposit1 = ethers.parseUnits("1000", 6);
      const deposit2 = ethers.parseUnits("2000", 6);
      const deposit3 = ethers.parseUnits("500", 6);

      // First user deposits
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), deposit1);
      await vault.connect(lp1).requestDeposit(deposit1);
      const impersonatedLiquidityOrchestrator1 = await impersonateLiquidityOrchestrator(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator1).processDepositRequests();
      await vault.connect(impersonatedLiquidityOrchestrator1).updateVaultState([], deposit1);

      const shares1 = await vault.balanceOf(lp1.address);
      const assets1 = await vault.convertToAssets(shares1);

      // Second user deposits
      await underlyingAsset.connect(lp2).approve(await vault.getAddress(), deposit2);
      await vault.connect(lp2).requestDeposit(deposit2);
      const impersonatedLiquidityOrchestrator2 = await impersonateLiquidityOrchestrator(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator2).processDepositRequests();
      await vault.connect(impersonatedLiquidityOrchestrator2).updateVaultState([], deposit1 + deposit2);

      const shares2 = await vault.balanceOf(lp2.address);
      const assets2 = await vault.convertToAssets(shares2);

      // Third user deposits
      await underlyingAsset.connect(lp3).approve(await vault.getAddress(), deposit3);
      await vault.connect(lp3).requestDeposit(deposit3);
      const impersonatedLiquidityOrchestrator3 = await impersonateLiquidityOrchestrator(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator3).processDepositRequests();
      await vault.connect(impersonatedLiquidityOrchestrator3).updateVaultState([], deposit1 + deposit2 + deposit3);

      const shares3 = await vault.balanceOf(lp3.address);
      const assets3 = await vault.convertToAssets(shares3);

      // All should maintain reasonable exchange rates
      expect(assets1).to.be.closeTo(deposit1, ethers.parseUnits("10", 6));
      expect(assets2).to.be.closeTo(deposit2, ethers.parseUnits("10", 6));
      expect(assets3).to.be.closeTo(deposit3, ethers.parseUnits("10", 6));
    });
  });

  describe("Mathematical Properties", function () {
    it("Should maintain monotonicity in conversions", async function () {
      const { vault, underlyingAsset, lp1, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseUnits("1000", 6);
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(lp1).requestDeposit(depositAmount);
      const impersonatedLiquidityOrchestrator = await impersonateLiquidityOrchestrator(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator).processDepositRequests();
      await vault.connect(impersonatedLiquidityOrchestrator).updateVaultState([], depositAmount);

      // Test monotonicity: larger inputs should produce larger outputs
      const amount1 = ethers.parseUnits("100", 6);
      const amount2 = ethers.parseUnits("200", 6);

      const shares1 = await vault.convertToShares(amount1);
      const shares2 = await vault.convertToShares(amount2);

      expect(shares2).to.be.gt(shares1);

      const assets1 = await vault.convertToAssets(shares1);
      const assets2 = await vault.convertToAssets(shares2);

      expect(assets2).to.be.gt(assets1);
    });

    it("Should handle proportional relationships correctly", async function () {
      const { vault, underlyingAsset, lp1, liquidityOrchestratorAddress } = await loadFixture(deployVaultFixture);

      const depositAmount = ethers.parseUnits("1000", 6);
      await underlyingAsset.connect(lp1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(lp1).requestDeposit(depositAmount);
      const impersonatedLiquidityOrchestrator = await impersonateLiquidityOrchestrator(liquidityOrchestratorAddress);
      await vault.connect(impersonatedLiquidityOrchestrator).processDepositRequests();
      await vault.connect(impersonatedLiquidityOrchestrator).updateVaultState([], depositAmount);

      // Test proportional relationships
      const baseAmount = ethers.parseUnits("100", 6);
      const baseShares = await vault.convertToShares(baseAmount);

      const doubleAmount = ethers.parseUnits("200", 6);
      const doubleShares = await vault.convertToShares(doubleAmount);

      // Should be approximately proportional
      expect(doubleShares).to.be.closeTo(baseShares * 2n, baseShares / 1000n);
    });
  });
});
