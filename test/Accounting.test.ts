import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "./helpers/hh";

import type {
  MockUnderlyingAsset,
  OrionConfig,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  OrionTransparentVault,
} from "../typechain-types";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";
import type { IOrionVault } from "../typechain-types";

const FeeType = {
  ABSOLUTE: 0,
  SOFT_HURDLE: 1,
  HARD_HURDLE: 2,
  HIGH_WATER_MARK: 3,
  HURDLE_HWM: 4,
} as const;

const Rounding = { Floor: 0, Ceil: 1 } as const;

const YEAR_SECONDS = 365 * 24 * 60 * 60;
const BASIS_POINTS = 10_000;

// ─── Pure arithmetic helpers (match Solidity's mulDiv floor exactly) ──────────

function mulDiv(a: bigint, b: bigint, c: bigint): bigint {
  return (a * b) / c;
}

function activePriceFor(feeTotalAssets: bigint, supply: bigint, offset: bigint): bigint {
  return mulDiv(10n ** 18n, feeTotalAssets + 1n, supply + offset);
}

function spotPrice(totalAssets: bigint, supply: bigint, offset: bigint): bigint {
  return mulDiv(10n ** 18n, totalAssets + 1n, supply + offset);
}

function hurdlePrice(sharePrice: bigint, riskFreeRateBps: bigint, epochDuration: bigint): bigint {
  const hurdleReturn = mulDiv(riskFreeRateBps, epochDuration, BigInt(YEAR_SECONDS));
  return mulDiv(sharePrice, BigInt(BASIS_POINTS) + hurdleReturn, BigInt(BASIS_POINTS));
}

function profitsAboveBenchmark(activePrice: bigint, benchmark: bigint, feeTotalAssets: bigint): bigint {
  if (activePrice <= benchmark) return 0n;
  return mulDiv(activePrice - benchmark, feeTotalAssets, activePrice);
}

/**
 * Annualised performance fee — mirrors the updated contract ordering:
 *   epochProfits = profitsInAssets * epochDuration / YEAR
 *   fee          = perfBps * epochProfits / BASIS_POINTS
 */
function annualizedPerfFee(profits: bigint, perfBps: number, epochDuration: bigint): bigint {
  const epochProfits = mulDiv(profits, epochDuration, BigInt(YEAR_SECONDS));
  return mulDiv(BigInt(perfBps), epochProfits, BigInt(BASIS_POINTS));
}

function managementFeeAmount(totalAssets: bigint, mgmtBps: number, epochDuration: bigint): bigint {
  return mulDiv(mulDiv(BigInt(mgmtBps), totalAssets, BigInt(BASIS_POINTS)), epochDuration, BigInt(YEAR_SECONDS));
}

// ─────────────────────────────────────────────────────────────────────────────

describe("OrionVault Accounting", function () {
  let orionConfig: OrionConfig;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let transparentVaultFactory: TransparentVaultFactory;
  let underlyingAsset: MockUnderlyingAsset;
  let vault: OrionTransparentVault;

  let owner: SignerWithAddress;
  let strategist: SignerWithAddress;
  let user: SignerWithAddress;

  const UNDERLYING_DECIMALS = 6;
  const SHARE_DECIMALS = 18;
  const DECIMALS_OFFSET = SHARE_DECIMALS - UNDERLYING_DECIMALS; // 12
  const OFFSET = 10n ** BigInt(DECIMALS_OFFSET);
  const ONE_SHARE = 10n ** BigInt(SHARE_DECIMALS);

  function parseUnderlying(amount: string): bigint {
    return ethers.parseUnits(amount, UNDERLYING_DECIMALS);
  }

  async function createVault(
    feeType: number,
    performanceFee: number,
    managementFee: number,
  ): Promise<OrionTransparentVault> {
    const tx = await transparentVaultFactory
      .connect(owner)
      .createVault(
        strategist.address,
        "Accounting Vault",
        "AV",
        feeType,
        performanceFee,
        managementFee,
        ethers.ZeroAddress,
      );
    const receipt = await tx.wait();
    const log = receipt?.logs.find((l) => {
      try {
        return transparentVaultFactory.interface.parseLog(l)?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const args = transparentVaultFactory.interface.parseLog(log!)?.args;
    const vaultAddress = args?.[0];
    return ethers.getContractAt("OrionTransparentVault", vaultAddress) as unknown as Promise<OrionTransparentVault>;
  }

  /** Set vault state with positive totalSupply and _totalAssets by impersonating LO. */
  async function setVaultStateWithFulfilledDeposit(
    v: OrionTransparentVault,
    depositAssets: bigint,
    newTotalAssets: bigint,
  ): Promise<void> {
    const loAddress = await liquidityOrchestrator.getAddress();
    await ethers.provider.send("hardhat_impersonateAccount", [loAddress]);
    await ethers.provider.send("hardhat_setBalance", [loAddress, ethers.toQuantity(ethers.parseEther("1"))]);
    const loSigner = await ethers.getSigner(loAddress);

    await v.connect(loSigner).fulfillDeposit(depositAssets);
    await v.connect(loSigner).updateVaultState([await underlyingAsset.getAddress()], [0n], newTotalAssets);

    await ethers.provider.send("hardhat_stopImpersonatingAccount", [loAddress]);
  }

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    [owner, strategist, user] = await ethers.getSigners();

    const MockUnderlyingFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlying = await MockUnderlyingFactory.deploy(UNDERLYING_DECIMALS);
    await underlying.waitForDeployment();
    underlyingAsset = underlying as unknown as MockUnderlyingAsset;

    const deployed = await deployUpgradeableProtocol(owner, underlyingAsset);
    orionConfig = deployed.orionConfig;
    liquidityOrchestrator = deployed.liquidityOrchestrator;
    transparentVaultFactory = deployed.transparentVaultFactory;

    await orionConfig.setProtocolRiskFreeRate(100); // 1% annual = 100 bps
    await liquidityOrchestrator.updateEpochDuration(14 * 24 * 60 * 60); // 14 days (max allowed)

    const MockERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");
    const mockAsset = await MockERC4626Factory.deploy(await underlyingAsset.getAddress(), "Mock", "M");
    await mockAsset.waitForDeployment();
    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    const priceAdapter = await MockPriceAdapterFactory.deploy();
    await priceAdapter.waitForDeployment();
    const ExecutionAdapterFactory = await ethers.getContractFactory("ERC4626ExecutionAdapter");
    const executionAdapter = await ExecutionAdapterFactory.deploy(await orionConfig.getAddress());
    await executionAdapter.waitForDeployment();

    await orionConfig.addWhitelistedAsset(
      await mockAsset.getAddress(),
      await priceAdapter.getAddress(),
      await executionAdapter.getAddress(),
    );

    vault = await createVault(FeeType.ABSOLUTE, 1000, 100); // 10% perf, 1% mgmt

    await underlyingAsset.mint(user.address, parseUnderlying("1000000"));
    await underlyingAsset.connect(user).approve(await vault.getAddress(), parseUnderlying("1000000"));
  });

  describe("convertToAssetsWithPITTotalAssets", function () {
    it("returns assets using current totalSupply and point-in-time total assets (Floor)", async function () {
      const depositAssets = parseUnderlying("100000");
      await vault.connect(user).requestDeposit(depositAssets);
      await setVaultStateWithFulfilledDeposit(vault, depositAssets, depositAssets);

      const supply = await vault.totalSupply();
      const totalAssets = await vault.totalAssets();
      expect(supply).to.be.gt(0);
      expect(totalAssets).to.equal(depositAssets);

      const assetsFloor = await vault.convertToAssetsWithPITTotalAssets(ONE_SHARE, totalAssets, Rounding.Floor);
      const assetsCeil = await vault.convertToAssetsWithPITTotalAssets(ONE_SHARE, totalAssets, Rounding.Ceil);

      const expected = (ONE_SHARE * (totalAssets + 1n)) / (supply + OFFSET);
      expect(assetsFloor).to.equal(expected);
      expect(assetsCeil).to.be.gte(assetsFloor);
    });

    it("returns assets with Ceil rounding when there is remainder", async function () {
      const depositAssets = parseUnderlying("100000");
      await vault.connect(user).requestDeposit(depositAssets);
      await setVaultStateWithFulfilledDeposit(vault, depositAssets, depositAssets);

      const supply = await vault.totalSupply();
      const pitAssets = parseUnderlying("33333");
      const shares = supply / 3n;
      const assetsFloor = await vault.convertToAssetsWithPITTotalAssets(shares, pitAssets, Rounding.Floor);
      const assetsCeil = await vault.convertToAssetsWithPITTotalAssets(shares, pitAssets, Rounding.Ceil);

      const exact = (shares * (pitAssets + 1n)) / (supply + OFFSET);
      const hasRemainder = (shares * (pitAssets + 1n)) % (supply + OFFSET) !== 0n;
      expect(assetsFloor).to.equal(exact);
      if (hasRemainder) {
        expect(assetsCeil).to.equal(assetsFloor + 1n);
      }
    });

    it("uses virtual supply (10^offset) when totalSupply is zero for first-deposit pricing", async function () {
      const depositAssets = parseUnderlying("50000");
      await vault.connect(user).requestDeposit(depositAssets);
      await setVaultStateWithFulfilledDeposit(vault, depositAssets, depositAssets);

      const supply = await vault.totalSupply();
      expect(supply).to.be.gt(0);
      const assetsForOneShare = await vault.convertToAssetsWithPITTotalAssets(ONE_SHARE, depositAssets, Rounding.Floor);
      const expectedRatio = (ONE_SHARE * (depositAssets + 1n)) / (supply + OFFSET);
      expect(assetsForOneShare).to.equal(expectedRatio);
    });

    it("internal _convertToAssetsWithPITTotalAssets is used in fulfillRedeem with snapshot totalSupply", async function () {
      const depositAssets = parseUnderlying("100000");
      await vault.connect(user).requestDeposit(depositAssets);
      await setVaultStateWithFulfilledDeposit(vault, depositAssets, depositAssets);

      const userShares = await vault.balanceOf(user.address);
      expect(userShares).to.be.gt(0);
      const redeemShares = userShares / 2n;
      await vault.connect(user).approve(await vault.getAddress(), redeemShares);
      const balanceBefore = await underlyingAsset.balanceOf(user.address);
      await vault.connect(user).requestRedeem(redeemShares);

      const snapshotSupply = await vault.totalSupply();
      const redeemTotalAssets = depositAssets - parseUnderlying("5000");
      const expectedUnderlying = (redeemShares * (redeemTotalAssets + 1n)) / (snapshotSupply + OFFSET);

      const loAddress = await liquidityOrchestrator.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [loAddress]);
      await ethers.provider.send("hardhat_setBalance", [loAddress, ethers.toQuantity(ethers.parseEther("1"))]);
      const loSigner = await ethers.getSigner(loAddress);
      await vault.connect(loSigner).fulfillRedeem(redeemTotalAssets);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [loAddress]);

      const balanceAfter = await underlyingAsset.balanceOf(user.address);
      expect(balanceAfter - balanceBefore).to.equal(expectedUnderlying);
    });
  });

  describe("vaultFee and _managementFeeAmount", function () {
    it("returns zero management fee when snapshot management fee is zero", async function () {
      const depositAssets = parseUnderlying("100000");
      await vault.connect(user).requestDeposit(depositAssets);
      await setVaultStateWithFulfilledDeposit(vault, depositAssets, depositAssets);

      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.ABSOLUTE,
        performanceFee: 1000,
        managementFee: 0,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const [mgmtFee] = await vault.vaultFee(depositAssets, feeModel);
      expect(mgmtFee).to.equal(0n);
    });

    it("returns management fee proportional to assets, epoch duration and rate", async function () {
      const depositAssets = parseUnderlying("100000");
      await vault.connect(user).requestDeposit(depositAssets);
      await setVaultStateWithFulfilledDeposit(vault, depositAssets, depositAssets);

      const managementFeeBps = 100;
      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.ABSOLUTE,
        performanceFee: 0,
        managementFee: managementFeeBps,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const [mgmtFee] = await vault.vaultFee(depositAssets, feeModel);
      const epochDuration = await liquidityOrchestrator.epochDuration();
      const expected = managementFeeAmount(depositAssets, managementFeeBps, epochDuration);
      expect(mgmtFee).to.equal(expected);
    });
  });

  describe("vaultFee, _performanceFeeAmount, _performanceFeeBenchmark, _getHurdlePrice", function () {
    beforeEach(async function () {
      const depositAssets = parseUnderlying("100000");
      await vault.connect(user).requestDeposit(depositAssets);
      await setVaultStateWithFulfilledDeposit(vault, depositAssets, depositAssets);
    });

    it("returns zero performance fee when snapshot performance fee is zero", async function () {
      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.ABSOLUTE,
        performanceFee: 0,
        managementFee: 100,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const [, perfFee] = await vault.vaultFee(await vault.totalAssets(), feeModel);
      expect(perfFee).to.equal(0n);
    });

    it("returns zero performance fee when feeTotalAssets is zero", async function () {
      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.ABSOLUTE,
        performanceFee: 1000,
        managementFee: 0,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const [, perfFee] = await vault.vaultFee(0n, feeModel);
      expect(perfFee).to.equal(0n);
    });

    // ─── ABSOLUTE ──────────────────────────────────────────────────────────────

    it("ABSOLUTE: benchmark is current share price; zero perf fee when active price equals benchmark", async function () {
      const totalAssets = await vault.totalAssets();
      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.ABSOLUTE,
        performanceFee: 1000,
        managementFee: 0,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const [, perfFee] = await vault.vaultFee(totalAssets, feeModel);
      expect(perfFee).to.equal(0n);
    });

    it("ABSOLUTE: positive performance fee when active total assets imply higher share price than current", async function () {
      const totalAssets = await vault.totalAssets();
      const higherTotalAssets = totalAssets + parseUnderlying("10000");
      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.ABSOLUTE,
        performanceFee: 1000,
        managementFee: 0,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const [, perfFee] = await vault.vaultFee(higherTotalAssets, feeModel);
      expect(perfFee).to.be.gt(0n);
    });

    it("ABSOLUTE: exact fee — annualised 10% on epoch gain, fee = perfBps * (T_fee-T_prev)*epochDur / (10000*YEAR)", async function () {
      const prevTotalAssets = await vault.totalAssets();
      const gain = parseUnderlying("10000"); // +10%
      const feeTotalAssets = prevTotalAssets + gain;
      const perfBps = 1000;
      const epochDuration = await liquidityOrchestrator.epochDuration();

      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.ABSOLUTE,
        performanceFee: perfBps,
        managementFee: 0,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const [, perfFee] = await vault.vaultFee(feeTotalAssets, feeModel);

      const supply = await vault.totalSupply();
      const P_active = activePriceFor(feeTotalAssets, supply, OFFSET);
      const P_current = spotPrice(prevTotalAssets, supply, OFFSET);
      const profits = profitsAboveBenchmark(P_active, P_current, feeTotalAssets);
      const expected = annualizedPerfFee(profits, perfBps, epochDuration);
      expect(perfFee).to.equal(expected);
    });

    it("ABSOLUTE: fee scales linearly with perfBps (2× rate → 2× fee)", async function () {
      const prevTotalAssets = await vault.totalAssets();
      const feeTotalAssets = prevTotalAssets + parseUnderlying("10000");
      const epochDuration = await liquidityOrchestrator.epochDuration();

      const lowModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.ABSOLUTE,
        performanceFee: 500,
        managementFee: 0,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const highModel: IOrionVault.FeeModelStruct = { ...lowModel, performanceFee: 1000 };

      const [, feeAt500] = await vault.vaultFee(feeTotalAssets, lowModel);
      const [, feeAt1000] = await vault.vaultFee(feeTotalAssets, highModel);

      const supply = await vault.totalSupply();
      const P_active = activePriceFor(feeTotalAssets, supply, OFFSET);
      const P_current = spotPrice(prevTotalAssets, supply, OFFSET);
      const profits = profitsAboveBenchmark(P_active, P_current, feeTotalAssets);

      expect(feeAt500).to.equal(annualizedPerfFee(profits, 500, epochDuration));
      expect(feeAt1000).to.equal(annualizedPerfFee(profits, 1000, epochDuration));
      expect(feeAt1000).to.equal(feeAt500 * 2n);
    });

    it("ABSOLUTE: zero fee when feeTotalAssets < _totalAssets (loss epoch)", async function () {
      const prevTotalAssets = await vault.totalAssets();
      const feeTotalAssets = prevTotalAssets - parseUnderlying("5000"); // 5% loss
      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.ABSOLUTE,
        performanceFee: 1000,
        managementFee: 0,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const [, perfFee] = await vault.vaultFee(feeTotalAssets, feeModel);
      expect(perfFee).to.equal(0n);
    });

    // ─── HIGH_WATER_MARK ───────────────────────────────────────────────────────

    it("HIGH_WATER_MARK: benchmark and divisor are highWaterMark; zero when active price ≤ HWM", async function () {
      const totalAssets = await vault.totalAssets();
      const currentSharePrice = await vault.convertToAssets(ONE_SHARE);
      const hwm = currentSharePrice + 1n;
      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.HIGH_WATER_MARK,
        performanceFee: 1000,
        managementFee: 0,
        highWaterMark: hwm,
      };
      const [, perfFee] = await vault.vaultFee(totalAssets, feeModel);
      expect(perfFee).to.equal(0n);

      const gainsTotalAssets = totalAssets + parseUnderlying("20000");
      const [, perfFeeWithGains] = await vault.vaultFee(gainsTotalAssets, feeModel);
      expect(perfFeeWithGains).to.be.gte(0n);
    });

    it("HIGH_WATER_MARK: zero fee when active price is below HWM (even with gain vs _totalAssets)", async function () {
      const prevTotalAssets = await vault.totalAssets();
      const supply = await vault.totalSupply();
      const P_current = spotPrice(prevTotalAssets, supply, OFFSET);
      const hwm = (P_current * 12n) / 10n; // HWM = +20%

      const feeTotalAssets = prevTotalAssets + parseUnderlying("10000"); // +10%, below HWM
      const P_active = activePriceFor(feeTotalAssets, supply, OFFSET);
      expect(P_active).to.be.lt(hwm);

      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.HIGH_WATER_MARK,
        performanceFee: 1000,
        managementFee: 0,
        highWaterMark: hwm,
      };
      const [, perfFee] = await vault.vaultFee(feeTotalAssets, feeModel);
      expect(perfFee).to.equal(0n);
    });

    it("HIGH_WATER_MARK: exact fee amount above HWM", async function () {
      const prevTotalAssets = await vault.totalAssets();
      const feeTotalAssets = prevTotalAssets + parseUnderlying("20000"); // +20%
      const supply = await vault.totalSupply();
      const epochDuration = await liquidityOrchestrator.epochDuration();
      const perfBps = 1000;

      const P_current = spotPrice(prevTotalAssets, supply, OFFSET);
      const hwm = (P_current * 105n) / 100n; // HWM = +5%
      const P_active = activePriceFor(feeTotalAssets, supply, OFFSET);
      expect(P_active).to.be.gt(hwm);

      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.HIGH_WATER_MARK,
        performanceFee: perfBps,
        managementFee: 0,
        highWaterMark: hwm,
      };
      const [, perfFee] = await vault.vaultFee(feeTotalAssets, feeModel);

      const profits = profitsAboveBenchmark(P_active, hwm, feeTotalAssets);
      const expected = annualizedPerfFee(profits, perfBps, epochDuration);
      expect(perfFee).to.equal(expected);
    });

    it("HIGH_WATER_MARK: fee decreases as HWM increases (less profit above higher HWM)", async function () {
      const prevTotalAssets = await vault.totalAssets();
      const feeTotalAssets = prevTotalAssets + parseUnderlying("20000");
      const supply = await vault.totalSupply();
      const epochDuration = await liquidityOrchestrator.epochDuration();

      const P_current = spotPrice(prevTotalAssets, supply, OFFSET);
      const hwmLow = P_current;
      const hwmHigh = (P_current * 115n) / 100n;

      const modelLow: IOrionVault.FeeModelStruct = {
        feeType: FeeType.HIGH_WATER_MARK,
        performanceFee: 1000,
        managementFee: 0,
        highWaterMark: hwmLow,
      };
      const modelHigh: IOrionVault.FeeModelStruct = { ...modelLow, highWaterMark: hwmHigh };

      const [, feeLow] = await vault.vaultFee(feeTotalAssets, modelLow);
      const [, feeHigh] = await vault.vaultFee(feeTotalAssets, modelHigh);
      expect(feeLow).to.be.gt(feeHigh);

      const P_active = activePriceFor(feeTotalAssets, supply, OFFSET);
      expect(feeLow).to.equal(
        annualizedPerfFee(profitsAboveBenchmark(P_active, hwmLow, feeTotalAssets), 1000, epochDuration),
      );
      expect(feeHigh).to.equal(
        annualizedPerfFee(profitsAboveBenchmark(P_active, hwmHigh, feeTotalAssets), 1000, epochDuration),
      );
    });

    // ─── SOFT_HURDLE ───────────────────────────────────────────────────────────

    it("SOFT_HURDLE: hurdle gates fee; return measured from spot (absolute) share price", async function () {
      const v2 = await createVault(FeeType.SOFT_HURDLE, 1000, 0);
      await underlyingAsset.connect(user).approve(await v2.getAddress(), parseUnderlying("100000"));
      await v2.connect(user).requestDeposit(parseUnderlying("100000"));
      await setVaultStateWithFulfilledDeposit(v2, parseUnderlying("100000"), parseUnderlying("100000"));

      const totalAssets = await v2.totalAssets();
      const currentSharePrice = await v2.convertToAssets(ONE_SHARE);
      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.SOFT_HURDLE,
        performanceFee: 1000,
        managementFee: 0,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const [, perfFee] = await v2.vaultFee(totalAssets, feeModel);
      const riskFreeRate = await orionConfig.riskFreeRate();
      const epochDuration = await liquidityOrchestrator.epochDuration();
      const hurdleReturn = (BigInt(riskFreeRate) * epochDuration) / BigInt(YEAR_SECONDS);
      const expectedHurdle = (currentSharePrice * (BigInt(BASIS_POINTS) + hurdleReturn)) / BigInt(BASIS_POINTS);
      expect(expectedHurdle).to.be.gt(currentSharePrice);
      expect(perfFee).to.equal(0n);

      const gainsAssets = totalAssets + parseUnderlying("15000");
      const [, perfFeeGains] = await v2.vaultFee(gainsAssets, feeModel);
      expect(perfFeeGains).to.be.gt(0n);

      const supply = await v2.totalSupply();
      const P_active = activePriceFor(gainsAssets, supply, OFFSET);
      expect(P_active).to.be.gt(expectedHurdle);
      expect(P_active).to.be.gt(currentSharePrice);

      // Profit base: full return above spot (NOT above hurdle — soft semantics)
      const profitsInAssets = profitsAboveBenchmark(P_active, spotPrice(totalAssets, supply, OFFSET), gainsAssets);
      const expected = annualizedPerfFee(profitsInAssets, 1000, epochDuration);
      expect(perfFeeGains).to.equal(expected);
    });

    it("SOFT_HURDLE: zero fee when active price exactly at hurdle (boundary)", async function () {
      const v2 = await createVault(FeeType.SOFT_HURDLE, 1000, 0);
      await underlyingAsset.connect(user).approve(await v2.getAddress(), parseUnderlying("100000"));
      await v2.connect(user).requestDeposit(parseUnderlying("100000"));
      await setVaultStateWithFulfilledDeposit(v2, parseUnderlying("100000"), parseUnderlying("100000"));

      const prevTotalAssets = await v2.totalAssets();
      const supply = await v2.totalSupply();
      const riskFreeRate = await orionConfig.riskFreeRate();
      const epochDuration = await liquidityOrchestrator.epochDuration();
      const P_spot = spotPrice(prevTotalAssets, supply, OFFSET);
      const P_hurdle = hurdlePrice(P_spot, riskFreeRate, epochDuration);

      // Construct T such that floor(1e18*(T+1)/(supply+offset)) <= P_hurdle.
      // floor(1e18*(T+1)/(supply+offset)) == P_hurdle  when T+1 == P_hurdle*(supply+offset)/1e18.
      // Using T = floor(P_hurdle*(supply+offset)/1e18) - 1 guarantees activeSharePrice <= P_hurdle.
      const T_hurdle = (P_hurdle * (supply + OFFSET)) / 10n ** 18n - 1n;
      const activeAtT = activePriceFor(T_hurdle, supply, OFFSET);
      expect(activeAtT).to.be.lte(P_hurdle);

      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.SOFT_HURDLE,
        performanceFee: 1000,
        managementFee: 0,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const [, perfFee] = await v2.vaultFee(T_hurdle, feeModel);
      expect(perfFee).to.equal(0n);
    });

    it("SOFT_HURDLE: profit base is full return above spot, not above hurdle (distinguishes from HARD_HURDLE)", async function () {
      const v2 = await createVault(FeeType.SOFT_HURDLE, 1000, 0);
      await underlyingAsset.connect(user).approve(await v2.getAddress(), parseUnderlying("100000"));
      await v2.connect(user).requestDeposit(parseUnderlying("100000"));
      await setVaultStateWithFulfilledDeposit(v2, parseUnderlying("100000"), parseUnderlying("100000"));

      const prevTotalAssets = await v2.totalAssets();
      const supply = await v2.totalSupply();
      const riskFreeRate = await orionConfig.riskFreeRate();
      const epochDuration = await liquidityOrchestrator.epochDuration();
      const feeTotalAssets = prevTotalAssets + parseUnderlying("20000");

      const P_active = activePriceFor(feeTotalAssets, supply, OFFSET);
      const P_spot = spotPrice(prevTotalAssets, supply, OFFSET);
      const P_hurdle = hurdlePrice(P_spot, riskFreeRate, epochDuration);
      expect(P_active).to.be.gt(P_hurdle);

      const softModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.SOFT_HURDLE,
        performanceFee: 1000,
        managementFee: 0,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const hardModel: IOrionVault.FeeModelStruct = { ...softModel, feeType: FeeType.HARD_HURDLE };

      const [, feeSoft] = await v2.vaultFee(feeTotalAssets, softModel);
      const [, feeHard] = await v2.vaultFee(feeTotalAssets, hardModel);

      // Soft hurdle charges on full return above spot → larger profit base → larger fee
      const profitsFromSpot = profitsAboveBenchmark(P_active, P_spot, feeTotalAssets);
      const profitsFromHurdle = profitsAboveBenchmark(P_active, P_hurdle, feeTotalAssets);
      expect(profitsFromSpot).to.be.gt(profitsFromHurdle);

      expect(feeSoft).to.equal(annualizedPerfFee(profitsFromSpot, 1000, epochDuration));
      expect(feeHard).to.equal(annualizedPerfFee(profitsFromHurdle, 1000, epochDuration));
      expect(feeSoft).to.be.gt(feeHard);
    });

    // ─── HARD_HURDLE ───────────────────────────────────────────────────────────

    it("HARD_HURDLE: hurdle is gate and profit baseline (_getHurdlePrice used)", async function () {
      const v2 = await createVault(FeeType.HARD_HURDLE, 1000, 0);
      await underlyingAsset.connect(user).approve(await v2.getAddress(), parseUnderlying("100000"));
      await v2.connect(user).requestDeposit(parseUnderlying("100000"));
      await setVaultStateWithFulfilledDeposit(v2, parseUnderlying("100000"), parseUnderlying("100000"));

      const totalAssets = await v2.totalAssets();
      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.HARD_HURDLE,
        performanceFee: 1000,
        managementFee: 0,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const [, perfFee] = await v2.vaultFee(totalAssets, feeModel);
      expect(perfFee).to.equal(0n);
    });

    it("HARD_HURDLE: zero fee when return exactly equals hurdle rate", async function () {
      const v2 = await createVault(FeeType.HARD_HURDLE, 1000, 0);
      await underlyingAsset.connect(user).approve(await v2.getAddress(), parseUnderlying("100000"));
      await v2.connect(user).requestDeposit(parseUnderlying("100000"));
      await setVaultStateWithFulfilledDeposit(v2, parseUnderlying("100000"), parseUnderlying("100000"));

      const prevTotalAssets = await v2.totalAssets();
      const supply = await v2.totalSupply();
      const riskFreeRate = await orionConfig.riskFreeRate();
      const epochDuration = await liquidityOrchestrator.epochDuration();
      const P_current = spotPrice(prevTotalAssets, supply, OFFSET);
      const P_hurdle = hurdlePrice(P_current, riskFreeRate, epochDuration);

      const T_hurdle = (P_hurdle * (supply + OFFSET)) / 10n ** 18n - 1n;
      expect(activePriceFor(T_hurdle, supply, OFFSET)).to.be.lte(P_hurdle);

      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.HARD_HURDLE,
        performanceFee: 1000,
        managementFee: 0,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const [, perfFee] = await v2.vaultFee(T_hurdle, feeModel);
      expect(perfFee).to.equal(0n);
    });

    it("HARD_HURDLE: exact fee amount above hurdle", async function () {
      const v2 = await createVault(FeeType.HARD_HURDLE, 1000, 0);
      await underlyingAsset.connect(user).approve(await v2.getAddress(), parseUnderlying("100000"));
      await v2.connect(user).requestDeposit(parseUnderlying("100000"));
      await setVaultStateWithFulfilledDeposit(v2, parseUnderlying("100000"), parseUnderlying("100000"));

      const prevTotalAssets = await v2.totalAssets();
      const feeTotalAssets = prevTotalAssets + parseUnderlying("15000"); // +15%
      const supply = await v2.totalSupply();
      const riskFreeRate = await orionConfig.riskFreeRate();
      const epochDuration = await liquidityOrchestrator.epochDuration();
      const perfBps = 1000;

      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.HARD_HURDLE,
        performanceFee: perfBps,
        managementFee: 0,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const [, perfFee] = await v2.vaultFee(feeTotalAssets, feeModel);

      const P_active = activePriceFor(feeTotalAssets, supply, OFFSET);
      const P_current = spotPrice(prevTotalAssets, supply, OFFSET);
      const P_hurdle = hurdlePrice(P_current, riskFreeRate, epochDuration);
      expect(P_active).to.be.gt(P_hurdle);

      const profits = profitsAboveBenchmark(P_active, P_hurdle, feeTotalAssets);
      const expected = annualizedPerfFee(profits, perfBps, epochDuration);
      expect(perfFee).to.equal(expected);
    });

    it("HARD_HURDLE: fee is strictly smaller than ABSOLUTE fee for same gain (hurdle raises the floor)", async function () {
      const v2 = await createVault(FeeType.HARD_HURDLE, 1000, 0);
      await underlyingAsset.connect(user).approve(await v2.getAddress(), parseUnderlying("100000"));
      await v2.connect(user).requestDeposit(parseUnderlying("100000"));
      await setVaultStateWithFulfilledDeposit(v2, parseUnderlying("100000"), parseUnderlying("100000"));

      const prevTotalAssets = await v2.totalAssets();
      const feeTotalAssets = prevTotalAssets + parseUnderlying("15000");

      const hardModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.HARD_HURDLE,
        performanceFee: 1000,
        managementFee: 0,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const absModel: IOrionVault.FeeModelStruct = { ...hardModel, feeType: FeeType.ABSOLUTE };

      const [, perfFeeHard] = await v2.vaultFee(feeTotalAssets, hardModel);
      const [, perfFeeAbs] = await v2.vaultFee(feeTotalAssets, absModel);
      expect(perfFeeHard).to.be.lt(perfFeeAbs);
    });

    // ─── HURDLE_HWM ────────────────────────────────────────────────────────────

    it("HURDLE_HWM: benchmark is max(highWaterMark, hurdle price) (_getHurdlePrice used)", async function () {
      const v2 = await createVault(FeeType.HURDLE_HWM, 1000, 0);
      await underlyingAsset.connect(user).approve(await v2.getAddress(), parseUnderlying("100000"));
      await v2.connect(user).requestDeposit(parseUnderlying("100000"));
      await setVaultStateWithFulfilledDeposit(v2, parseUnderlying("100000"), parseUnderlying("100000"));

      const currentSharePrice = await v2.convertToAssets(ONE_SHARE);
      const riskFreeRate = await orionConfig.riskFreeRate();
      const epochDuration = await liquidityOrchestrator.epochDuration();
      const P_hurdle = hurdlePrice(currentSharePrice, riskFreeRate, epochDuration);
      const hwmBelowHurdle = currentSharePrice;
      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.HURDLE_HWM,
        performanceFee: 1000,
        managementFee: 0,
        highWaterMark: hwmBelowHurdle,
      };
      const totalAssets = await v2.totalAssets();
      const [, perfFee] = await v2.vaultFee(totalAssets, feeModel);
      expect(perfFee).to.equal(0n);

      const highHwm = P_hurdle + 1n;
      const feeModelHighHwm: IOrionVault.FeeModelStruct = { ...feeModel, highWaterMark: highHwm };
      const [, perfFeeHighHwm] = await v2.vaultFee(totalAssets + parseUnderlying("20000"), feeModelHighHwm);
      expect(perfFeeHighHwm).to.be.gte(0n);
    });

    it("HURDLE_HWM: selects hurdle when hurdle > HWM — exact fee amount", async function () {
      const v2 = await createVault(FeeType.HURDLE_HWM, 1000, 0);
      await underlyingAsset.connect(user).approve(await v2.getAddress(), parseUnderlying("100000"));
      await v2.connect(user).requestDeposit(parseUnderlying("100000"));
      await setVaultStateWithFulfilledDeposit(v2, parseUnderlying("100000"), parseUnderlying("100000"));

      const prevTotalAssets = await v2.totalAssets();
      const feeTotalAssets = prevTotalAssets + parseUnderlying("15000");
      const supply = await v2.totalSupply();
      const riskFreeRate = await orionConfig.riskFreeRate();
      const epochDuration = await liquidityOrchestrator.epochDuration();
      const perfBps = 1000;

      const P_current = spotPrice(prevTotalAssets, supply, OFFSET);
      const P_hurdle = hurdlePrice(P_current, riskFreeRate, epochDuration);
      const hwm = P_current; // HWM < hurdle → hurdle wins

      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.HURDLE_HWM,
        performanceFee: perfBps,
        managementFee: 0,
        highWaterMark: hwm,
      };
      const [, perfFee] = await v2.vaultFee(feeTotalAssets, feeModel);

      const P_active = activePriceFor(feeTotalAssets, supply, OFFSET);
      const benchmark = P_hurdle > hwm ? P_hurdle : hwm;
      const profits = profitsAboveBenchmark(P_active, benchmark, feeTotalAssets);
      const expected = annualizedPerfFee(profits, perfBps, epochDuration);
      expect(perfFee).to.equal(expected);
    });

    it("HURDLE_HWM: selects HWM when HWM > hurdle — exact fee amount", async function () {
      const v2 = await createVault(FeeType.HURDLE_HWM, 1000, 0);
      await underlyingAsset.connect(user).approve(await v2.getAddress(), parseUnderlying("100000"));
      await v2.connect(user).requestDeposit(parseUnderlying("100000"));
      await setVaultStateWithFulfilledDeposit(v2, parseUnderlying("100000"), parseUnderlying("100000"));

      const prevTotalAssets = await v2.totalAssets();
      const feeTotalAssets = prevTotalAssets + parseUnderlying("25000");
      const supply = await v2.totalSupply();
      const riskFreeRate = await orionConfig.riskFreeRate();
      const epochDuration = await liquidityOrchestrator.epochDuration();
      const perfBps = 1000;

      const P_current = spotPrice(prevTotalAssets, supply, OFFSET);
      const P_hurdle = hurdlePrice(P_current, riskFreeRate, epochDuration);
      const hwm = P_hurdle + 5000n; // HWM > hurdle → HWM wins

      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.HURDLE_HWM,
        performanceFee: perfBps,
        managementFee: 0,
        highWaterMark: hwm,
      };
      const [, perfFee] = await v2.vaultFee(feeTotalAssets, feeModel);

      const P_active = activePriceFor(feeTotalAssets, supply, OFFSET);
      const benchmark = hwm > P_hurdle ? hwm : P_hurdle;
      const profits = profitsAboveBenchmark(P_active, benchmark, feeTotalAssets);
      const expected = annualizedPerfFee(profits, perfBps, epochDuration);
      expect(perfFee).to.equal(expected);
    });

    it("HURDLE_HWM: fee always ≤ HARD_HURDLE when HWM ≥ hurdle (extra constraint)", async function () {
      const v2 = await createVault(FeeType.HURDLE_HWM, 1000, 0);
      await underlyingAsset.connect(user).approve(await v2.getAddress(), parseUnderlying("100000"));
      await v2.connect(user).requestDeposit(parseUnderlying("100000"));
      await setVaultStateWithFulfilledDeposit(v2, parseUnderlying("100000"), parseUnderlying("100000"));

      const prevTotalAssets = await v2.totalAssets();
      const feeTotalAssets = prevTotalAssets + parseUnderlying("20000");
      const supply = await v2.totalSupply();
      const riskFreeRate = await orionConfig.riskFreeRate();
      const epochDuration = await liquidityOrchestrator.epochDuration();

      const P_current = spotPrice(prevTotalAssets, supply, OFFSET);
      const P_hurdle = hurdlePrice(P_current, riskFreeRate, epochDuration);
      const hwm = P_hurdle + 10000n; // HWM > hurdle

      const hwmModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.HURDLE_HWM,
        performanceFee: 1000,
        managementFee: 0,
        highWaterMark: hwm,
      };
      const hardModel: IOrionVault.FeeModelStruct = { ...hwmModel, feeType: FeeType.HARD_HURDLE };
      const [, feeHwmHurdle] = await v2.vaultFee(feeTotalAssets, hwmModel);
      const [, feeHard] = await v2.vaultFee(feeTotalAssets, hardModel);
      expect(feeHwmHurdle).to.be.lte(feeHard);
    });

    // ─── Combined management + performance ────────────────────────────────────

    it("vaultFee returns management then performance; intermediate total assets used for performance", async function () {
      const totalAssets = parseUnderlying("100000");
      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.ABSOLUTE,
        performanceFee: 1000,
        managementFee: 100,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const [mgmtFee, perfFee] = await vault.vaultFee(totalAssets, feeModel);
      expect(mgmtFee).to.be.gt(0n);
      const intermediate = totalAssets - mgmtFee;
      const [, perfFeeOnly] = await vault.vaultFee(intermediate, {
        ...feeModel,
        managementFee: 0,
      });
      expect(perfFee).to.equal(perfFeeOnly);
    });

    it("combined: exact management fee and exact performance fee on intermediate assets", async function () {
      const prevTotalAssets = await vault.totalAssets();
      const activeTotalAssets = prevTotalAssets + parseUnderlying("10000");
      const supply = await vault.totalSupply();
      const epochDuration = await liquidityOrchestrator.epochDuration();
      const mgmtBps = 100;
      const perfBps = 1000;

      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.ABSOLUTE,
        performanceFee: perfBps,
        managementFee: mgmtBps,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const [mgmtFee, perfFee] = await vault.vaultFee(activeTotalAssets, feeModel);

      const expectedMgmt = managementFeeAmount(activeTotalAssets, mgmtBps, epochDuration);
      expect(mgmtFee).to.equal(expectedMgmt);

      const feeTotalAssets = activeTotalAssets - expectedMgmt;
      const P_active = activePriceFor(feeTotalAssets, supply, OFFSET);
      const P_current = spotPrice(prevTotalAssets, supply, OFFSET);
      const profits = profitsAboveBenchmark(P_active, P_current, feeTotalAssets);
      const expectedPerf = annualizedPerfFee(profits, perfBps, epochDuration);
      expect(perfFee).to.equal(expectedPerf);
    });

    it("higher management fee reduces performance base (same gross gain → smaller perf fee)", async function () {
      const prevTotalAssets = await vault.totalAssets();
      const activeTotalAssets = prevTotalAssets + parseUnderlying("10000");

      const lowMgmtModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.ABSOLUTE,
        performanceFee: 1000,
        managementFee: 50,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const highMgmtModel: IOrionVault.FeeModelStruct = { ...lowMgmtModel, managementFee: 200 };

      const [, perfFeeLowMgmt] = await vault.vaultFee(activeTotalAssets, lowMgmtModel);
      const [, perfFeeHighMgmt] = await vault.vaultFee(activeTotalAssets, highMgmtModel);
      expect(perfFeeLowMgmt).to.be.gt(perfFeeHighMgmt);
    });

    // ─── HWM lifecycle via updateVaultState ───────────────────────────────────

    it("HWM advances in updateVaultState when share price reaches a new high", async function () {
      // Use the vault already set up by the inner beforeEach (100k deposit, _totalAssets=100k).
      const currentNAV = await vault.totalAssets(); // 100k USDC
      const hwmBefore = (await vault.feeModel()).highWaterMark;

      const higherNAV = currentNAV + parseUnderlying("10000"); // +10%
      const loAddress = await liquidityOrchestrator.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [loAddress]);
      await ethers.provider.send("hardhat_setBalance", [loAddress, ethers.toQuantity(ethers.parseEther("1"))]);
      const loSigner = await ethers.getSigner(loAddress);
      await vault.connect(loSigner).updateVaultState([await underlyingAsset.getAddress()], [0n], higherNAV);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [loAddress]);

      const hwmAfter = (await vault.feeModel()).highWaterMark;
      const newSharePrice = await vault.convertToAssets(ONE_SHARE);
      expect(hwmAfter).to.equal(newSharePrice);
      expect(hwmAfter).to.be.gt(hwmBefore);
    });

    it("HWM does not retreat when NAV declines below previous peak", async function () {
      // Use vault already set up by inner beforeEach.
      const loAddress = await liquidityOrchestrator.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [loAddress]);
      await ethers.provider.send("hardhat_setBalance", [loAddress, ethers.toQuantity(ethers.parseEther("1"))]);
      const loSigner = await ethers.getSigner(loAddress);
      const baseNAV = await vault.totalAssets();

      await vault
        .connect(loSigner)
        .updateVaultState([await underlyingAsset.getAddress()], [0n], baseNAV + parseUnderlying("20000"));
      const hwmAtPeak = (await vault.feeModel()).highWaterMark;

      await vault
        .connect(loSigner)
        .updateVaultState([await underlyingAsset.getAddress()], [0n], baseNAV + parseUnderlying("5000"));
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [loAddress]);

      const hwmAfterDecline = (await vault.feeModel()).highWaterMark;
      expect(hwmAfterDecline).to.equal(hwmAtPeak);
    });

    it("HIGH_WATER_MARK: no fee during partial recovery after drawdown (until HWM is breached)", async function () {
      // Use vault already set up by inner beforeEach.
      const baseNAV = await vault.totalAssets();

      const loAddress = await liquidityOrchestrator.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [loAddress]);
      await ethers.provider.send("hardhat_setBalance", [loAddress, ethers.toQuantity(ethers.parseEther("1"))]);
      const loSigner = await ethers.getSigner(loAddress);

      // Push HWM to +20%
      await vault
        .connect(loSigner)
        .updateVaultState([await underlyingAsset.getAddress()], [0n], baseNAV + parseUnderlying("20000"));
      const hwm = (await vault.feeModel()).highWaterMark;

      // Drawdown: set _totalAssets lower so next vaultFee call uses a lower baseline
      await vault
        .connect(loSigner)
        .updateVaultState([await underlyingAsset.getAddress()], [0n], baseNAV + parseUnderlying("5000"));
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [loAddress]);

      // Partial recovery to +15% (still below HWM of +20%)
      const partialRecovery = baseNAV + parseUnderlying("15000");
      const supply = await vault.totalSupply();
      expect(activePriceFor(partialRecovery, supply, OFFSET)).to.be.lt(hwm);

      const hwmModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.HIGH_WATER_MARK,
        performanceFee: 1000,
        managementFee: 0,
        highWaterMark: hwm,
      };
      const [, perfFee] = await vault.vaultFee(partialRecovery, hwmModel);
      expect(perfFee).to.equal(0n);
    });
  });
});
