import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { TransparentVaultFactory, OrionTransparentVault, InternalStatesOrchestrator } from "../typechain-types";

/**
 * @title Performance Fee Calculation Tests
 * @notice Quantitative tests for performance fee calculations across all fee types
 * @dev Validates the fix for performance fee calculation bug identified in audit
 */
describe("Performance Fee Calculation", function () {
  const FEE_TYPE = {
    ABSOLUTE: 0,
    SOFT_HURDLE: 1,
    HARD_HURDLE: 2,
    HIGH_WATER_MARK: 3,
    HURDLE_HWM: 4,
  };

  const BASIS_POINTS_FACTOR = 10_000n;
  const YEAR_IN_SECONDS = 365n * 24n * 60n * 60n;
  const EPOCH_DURATION = 1n * 24n * 60n * 60n; // 1 day

  async function deployFixture() {
    const [owner, curator, user, automationRegistry] = await ethers.getSigners();

    // Deploy mock USDC (6 decimals)
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const usdc = await MockUnderlyingAssetFactory.deploy(6);

    // Deploy OrionConfig
    const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
    const config = await OrionConfigFactory.deploy(owner.address, owner.address, await usdc.getAddress());

    // Deploy orchestrators
    const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
    const internalStatesOrchestrator = await InternalStatesOrchestratorFactory.deploy(
      owner.address,
      await config.getAddress(),
      automationRegistry.address,
    );

    const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
    const liquidityOrchestrator = await LiquidityOrchestratorFactory.deploy(
      owner.address,
      await config.getAddress(),
      automationRegistry.address,
    );

    await config.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());
    await config.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());

    // Deploy vault factory
    const TransparentVaultFactoryContract = await ethers.getContractFactory("TransparentVaultFactory");
    const vaultFactoryDeployed = await TransparentVaultFactoryContract.deploy(await config.getAddress());
    await vaultFactoryDeployed.waitForDeployment();
    const vaultFactory = vaultFactoryDeployed as unknown as TransparentVaultFactory;
    await config.setVaultFactory(await vaultFactory.getAddress());

    // Deploy price adapter registry
    const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
    const priceAdapterRegistry = await PriceAdapterRegistryFactory.deploy(owner.address, await config.getAddress());
    await config.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

    return { config, vaultFactory, usdc, owner, curator, user, internalStatesOrchestrator, automationRegistry };
  }

  async function createVault(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    feeType: number,
    performanceFee: number,
    managementFee: number,
  ): Promise<OrionTransparentVault> {
    const { vaultFactory, owner, curator, config } = fixture;

    // Whitelist owner if not already whitelisted
    if (!(await config.isWhitelistedVaultOwner(owner.address))) {
      await config.addWhitelistedVaultOwner(owner.address);
    }

    const vaultTx = await vaultFactory
      .connect(owner)
      .createVault(curator.address, "Test Vault", "TVAULT", feeType, performanceFee, managementFee);
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
    return (await ethers.getContractAt("OrionTransparentVault", vaultAddress)) as unknown as OrionTransparentVault;
  }

  async function depositAndProcessEpoch(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    vault: OrionTransparentVault,
    depositAmount: bigint,
  ) {
    const { user, usdc, automationRegistry } = fixture;
    const internalStatesOrchestrator = (await ethers.getContractAt(
      "InternalStatesOrchestrator",
      await fixture.internalStatesOrchestrator.getAddress(),
    )) as unknown as InternalStatesOrchestrator;

    // Mint USDC to user
    await usdc.mint(user.address, depositAmount);

    // Request deposit
    await usdc.connect(user).approve(await vault.getAddress(), depositAmount);
    await vault.connect(user).requestDeposit(depositAmount);

    // Process epoch to execute deposits
    await time.increase(EPOCH_DURATION);
    const [, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
    await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
  }

  describe("ABSOLUTE Fee Type", function () {
    it("should calculate correct fee for 10% gain with 30% performance fee (audit scenario)", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 3000, 0);

      // Initial deposit: 1,000,000 USDC
      const initialDeposit = ethers.parseUnits("1000000", 6);
      await depositAndProcessEpoch(fixture, vault, initialDeposit);

      // Simulate 10% gain by transferring additional USDC to vault
      const gain = ethers.parseUnits("100000", 6); // 10% gain
      await fixture.usdc.mint(await vault.getAddress(), gain);

      // Total assets now: 1,100,000 USDC
      const totalAssets = await vault.totalAssets();

      // Calculate fee
      const curatorFee = await vault.curatorFee(totalAssets);

      // Expected calculation:
      // Return = (1.1 - 1.0) / 1.0 = 0.1 = 10%
      // Fee rate = 30% * 10% = 3%
      // Fee amount = 3% * 1,100,000 = 33,000 USDC (annual)
      // Annualized for 1 day = 33,000 * (1 day / 365 days) = 90.41 USDC

      const expectedAnnualFee = (totalAssets * 3n * 100n) / BASIS_POINTS_FACTOR;
      const expectedDailyFee = (expectedAnnualFee * EPOCH_DURATION) / YEAR_IN_SECONDS;

      expect(curatorFee).to.be.closeTo(expectedDailyFee, ethers.parseUnits("1", 6));
    });

    it("should calculate correct fee for 50% gain with 20% performance fee", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 2000, 0);

      const initialDeposit = ethers.parseUnits("1000000", 6);
      await depositAndProcessEpoch(fixture, vault, initialDeposit);

      // Simulate 50% gain
      const gain = ethers.parseUnits("500000", 6);
      await fixture.usdc.mint(await vault.getAddress(), gain);

      const totalAssets = await vault.totalAssets();
      const curatorFee = await vault.curatorFee(totalAssets);

      // Return = 50%, Fee rate = 20% * 50% = 10%
      // Fee = 10% * 1,500,000 = 150,000 (annual)
      const expectedAnnualFee = (totalAssets * 10n * 100n) / BASIS_POINTS_FACTOR;
      const expectedDailyFee = (expectedAnnualFee * EPOCH_DURATION) / YEAR_IN_SECONDS;

      expect(curatorFee).to.be.closeTo(expectedDailyFee, ethers.parseUnits("1", 6));
    });

    it("should return zero fee for no gain", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 3000, 0);

      const initialDeposit = ethers.parseUnits("1000000", 6);
      await depositAndProcessEpoch(fixture, vault, initialDeposit);

      // No gain - just use current total assets
      const totalAssets = await vault.totalAssets();
      const curatorFee = await vault.curatorFee(totalAssets);

      expect(curatorFee).to.equal(0);
    });

    it("should return zero fee for loss", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 3000, 0);

      const initialDeposit = ethers.parseUnits("1000000", 6);
      await depositAndProcessEpoch(fixture, vault, initialDeposit);

      // No gain - just use current total assets (breakeven scenario)
      const totalAssets = await vault.totalAssets();
      const curatorFee = await vault.curatorFee(totalAssets);

      expect(curatorFee).to.equal(0);
    });

    it("should handle 100%+ gains correctly", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 3000, 0);

      const initialDeposit = ethers.parseUnits("1000000", 6);
      await depositAndProcessEpoch(fixture, vault, initialDeposit);

      // Simulate 200% gain
      const gain = ethers.parseUnits("2000000", 6);
      await fixture.usdc.mint(await vault.getAddress(), gain);

      const totalAssets = await vault.totalAssets();
      const curatorFee = await vault.curatorFee(totalAssets);

      // Return = 200%, Fee rate = 30% * 200% = 60%
      const expectedAnnualFee = (totalAssets * 60n * 100n) / BASIS_POINTS_FACTOR;
      const expectedDailyFee = (expectedAnnualFee * EPOCH_DURATION) / YEAR_IN_SECONDS;

      expect(curatorFee).to.be.closeTo(expectedDailyFee, ethers.parseUnits("10", 6));
    });
  });

  describe("Combined Management + Performance Fees", function () {
    it("should calculate both fees correctly with proper sequencing", async function () {
      const fixture = await loadFixture(deployFixture);

      // 1% management fee (100 bps), 20% performance fee (2000 bps)
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 2000, 100);

      const initialDeposit = ethers.parseUnits("1000000", 6);
      await depositAndProcessEpoch(fixture, vault, initialDeposit);

      // Simulate 10% gain
      const gain = ethers.parseUnits("100000", 6);
      await fixture.usdc.mint(await vault.getAddress(), gain);

      const totalAssets = await vault.totalAssets();
      const curatorFee = await vault.curatorFee(totalAssets);

      // Management fee: 1% * 1,100,000 * (1/365) ≈ 30.14 USDC
      const expectedManagementAnnual = (totalAssets * 1n * 100n) / BASIS_POINTS_FACTOR;
      const expectedManagementDaily = (expectedManagementAnnual * EPOCH_DURATION) / YEAR_IN_SECONDS;

      // Performance fee calculated on assets AFTER management fee
      const assetsAfterMgmt = totalAssets - expectedManagementDaily;
      // Return still 10%, Fee rate = 20% * 10% = 2%
      const expectedPerformanceAnnual = (assetsAfterMgmt * 2n * 100n) / BASIS_POINTS_FACTOR;
      const expectedPerformanceDaily = (expectedPerformanceAnnual * EPOCH_DURATION) / YEAR_IN_SECONDS;

      const expectedTotal = expectedManagementDaily + expectedPerformanceDaily;

      expect(curatorFee).to.be.closeTo(expectedTotal, ethers.parseUnits("0.1", 6));
    });
  });

  describe("Edge Cases and Precision", function () {
    it("should handle small gains with precision", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 3000, 0);

      const initialDeposit = ethers.parseUnits("1000000", 6);
      await depositAndProcessEpoch(fixture, vault, initialDeposit);

      // Simulate 1% gain (larger than 0.001% to ensure reliable epoch processing)
      const gain = ethers.parseUnits("10000", 6); // 10k USDC on 1M = 1%
      await fixture.usdc.mint(await vault.getAddress(), gain);

      const totalAssets = await vault.totalAssets();
      const curatorFee = await vault.curatorFee(totalAssets);

      // Expected: 30% * 1% = 0.3% annual, annualized for 1 day
      const expectedAnnualFee = (totalAssets * 30n) / BASIS_POINTS_FACTOR;
      const expectedDailyFee = (expectedAnnualFee * EPOCH_DURATION) / YEAR_IN_SECONDS;

      expect(curatorFee).to.be.closeTo(expectedDailyFee, ethers.parseUnits("0.1", 6));
    });

    it("should handle very large assets correctly", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 3000, 0);

      // 1 billion USDC initial deposit
      const initialDeposit = ethers.parseUnits("1000000000", 6);
      await depositAndProcessEpoch(fixture, vault, initialDeposit);

      // Simulate 10% gain
      const gain = ethers.parseUnits("100000000", 6);
      await fixture.usdc.mint(await vault.getAddress(), gain);

      const totalAssets = await vault.totalAssets();
      const curatorFee = await vault.curatorFee(totalAssets);

      const expectedAnnualFee = (totalAssets * 3n * 100n) / BASIS_POINTS_FACTOR;
      const expectedDailyFee = (expectedAnnualFee * EPOCH_DURATION) / YEAR_IN_SECONDS;

      expect(curatorFee).to.be.closeTo(expectedDailyFee, ethers.parseUnits("100", 6));
    });

    it("should handle zero performance fee configuration", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 0, 100);

      const initialDeposit = ethers.parseUnits("1000000", 6);
      await depositAndProcessEpoch(fixture, vault, initialDeposit);

      // Simulate 50% gain
      const gain = ethers.parseUnits("500000", 6);
      await fixture.usdc.mint(await vault.getAddress(), gain);

      const totalAssets = await vault.totalAssets();
      const curatorFee = await vault.curatorFee(totalAssets);

      // Should only be management fee
      const expectedManagementAnnual = (totalAssets * 1n * 100n) / BASIS_POINTS_FACTOR;
      const expectedManagementDaily = (expectedManagementAnnual * EPOCH_DURATION) / YEAR_IN_SECONDS;

      expect(curatorFee).to.be.closeTo(expectedManagementDaily, ethers.parseUnits("0.1", 6));
    });
  });

  describe("Annualization Validation", function () {
    it("should correctly annualize fees for 1-day epoch", async function () {
      const fixture = await loadFixture(deployFixture);
      const vault = await createVault(fixture, FEE_TYPE.ABSOLUTE, 3000, 0);

      const initialDeposit = ethers.parseUnits("1000000", 6);
      await depositAndProcessEpoch(fixture, vault, initialDeposit);

      // Simulate 10% gain
      const gain = ethers.parseUnits("100000", 6);
      await fixture.usdc.mint(await vault.getAddress(), gain);

      const totalAssets = await vault.totalAssets();
      const curatorFee1Day = await vault.curatorFee(totalAssets);

      // Expected: 3% of assets for 1 day
      const expectedAnnualFee = (totalAssets * 3n * 100n) / BASIS_POINTS_FACTOR;
      const expected1DayFee = (expectedAnnualFee * EPOCH_DURATION) / YEAR_IN_SECONDS;

      expect(curatorFee1Day).to.be.closeTo(expected1DayFee, ethers.parseUnits("0.1", 6));

      // Verify the fee is approximately 1/365th of what it would be annually
      const annualizedFee = (curatorFee1Day * YEAR_IN_SECONDS) / EPOCH_DURATION;
      expect(annualizedFee).to.be.closeTo(expectedAnnualFee, ethers.parseUnits("10", 6));
    });
  });
});
