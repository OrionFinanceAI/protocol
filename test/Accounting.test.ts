import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import "@openzeppelin/hardhat-upgrades";
import { ethers } from "hardhat";

import {
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
    const ExecutionAdapterFactory = await ethers.getContractFactory("OrionAssetERC4626ExecutionAdapter");
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

      const oneShare = 10n ** BigInt(SHARE_DECIMALS);
      const assetsFloor = await vault.convertToAssetsWithPITTotalAssets(oneShare, totalAssets, Rounding.Floor);
      const assetsCeil = await vault.convertToAssetsWithPITTotalAssets(oneShare, totalAssets, Rounding.Ceil);

      const offset = 10n ** BigInt(DECIMALS_OFFSET);
      const expected = (oneShare * (totalAssets + 1n)) / (supply + offset);
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

      const offset = 10n ** BigInt(DECIMALS_OFFSET);
      const exact = (shares * (pitAssets + 1n)) / (supply + offset);
      const hasRemainder = (shares * (pitAssets + 1n)) % (supply + offset) !== 0n;
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
      const offset = 10n ** BigInt(DECIMALS_OFFSET);
      expect(supply).to.be.gt(0);
      const oneShare = 10n ** BigInt(SHARE_DECIMALS);
      const assetsForOneShare = await vault.convertToAssetsWithPITTotalAssets(oneShare, depositAssets, Rounding.Floor);
      const expectedRatio = (oneShare * (depositAssets + 1n)) / (supply + offset);
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
      const offset = 10n ** BigInt(DECIMALS_OFFSET);
      const expectedUnderlying = (redeemShares * (redeemTotalAssets + 1n)) / (snapshotSupply + offset);

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
      const depositAssets = parseUnderlying("100000"); // 100k units
      await vault.connect(user).requestDeposit(depositAssets);
      await setVaultStateWithFulfilledDeposit(vault, depositAssets, depositAssets);

      const managementFeeBps = 100; // 1%
      const feeModel: IOrionVault.FeeModelStruct = {
        feeType: FeeType.ABSOLUTE,
        performanceFee: 0,
        managementFee: managementFeeBps,
        highWaterMark: 10n ** BigInt(UNDERLYING_DECIMALS),
      };
      const [mgmtFee] = await vault.vaultFee(depositAssets, feeModel);
      const epochDuration = await liquidityOrchestrator.epochDuration();
      const expected = (BigInt(managementFeeBps) * depositAssets * epochDuration) / BigInt(BASIS_POINTS * YEAR_SECONDS);
      expect(mgmtFee).to.equal(expected);
    });
  });

  describe("vaultFee, _performanceFeeAmount, _getBenchmark, _getHurdlePrice", function () {
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

    it("ABSOLUTE: benchmark and divisor are current share price; zero perf fee when active price equals benchmark", async function () {
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

    it("HIGH_WATER_MARK: benchmark and divisor are highWaterMark", async function () {
      const totalAssets = await vault.totalAssets();
      const currentSharePrice = await vault.convertToAssets(10n ** BigInt(SHARE_DECIMALS));
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

    it("SOFT_HURDLE: benchmark is hurdle price, divisor is current share price (_getHurdlePrice used)", async function () {
      const v2 = await createVault(FeeType.SOFT_HURDLE, 1000, 0);
      await underlyingAsset.connect(user).approve(await v2.getAddress(), parseUnderlying("100000"));
      await v2.connect(user).requestDeposit(parseUnderlying("100000"));
      await setVaultStateWithFulfilledDeposit(v2, parseUnderlying("100000"), parseUnderlying("100000"));

      const totalAssets = await v2.totalAssets();
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
      const currentSharePrice = await v2.convertToAssets(10n ** BigInt(SHARE_DECIMALS));
      const expectedHurdle = (currentSharePrice * (BigInt(BASIS_POINTS) + hurdleReturn)) / BigInt(BASIS_POINTS);
      expect(expectedHurdle).to.be.gt(currentSharePrice);
      expect(perfFee).to.equal(0n);

      const gainsAssets = totalAssets + parseUnderlying("15000");
      const [, perfFeeGains] = await v2.vaultFee(gainsAssets, feeModel);
      expect(perfFeeGains).to.be.gte(0n);
    });

    it("HARD_HURDLE: benchmark and divisor are hurdle price (_getHurdlePrice used)", async function () {
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

    it("HURDLE_HWM: benchmark is max(highWaterMark, hurdle price) (_getHurdlePrice used)", async function () {
      const v2 = await createVault(FeeType.HURDLE_HWM, 1000, 0);
      await underlyingAsset.connect(user).approve(await v2.getAddress(), parseUnderlying("100000"));
      await v2.connect(user).requestDeposit(parseUnderlying("100000"));
      await setVaultStateWithFulfilledDeposit(v2, parseUnderlying("100000"), parseUnderlying("100000"));

      const currentSharePrice = await v2.convertToAssets(10n ** BigInt(SHARE_DECIMALS));
      const riskFreeRate = await orionConfig.riskFreeRate();
      const epochDuration = await liquidityOrchestrator.epochDuration();
      const hurdleReturn = (BigInt(riskFreeRate) * epochDuration) / BigInt(YEAR_SECONDS);
      const hurdlePrice = (currentSharePrice * (BigInt(BASIS_POINTS) + hurdleReturn)) / BigInt(BASIS_POINTS);
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

      const highHwm = hurdlePrice + 1n;
      const feeModelHighHwm: IOrionVault.FeeModelStruct = {
        ...feeModel,
        highWaterMark: highHwm,
      };
      const [, perfFeeHighHwm] = await v2.vaultFee(totalAssets + parseUnderlying("20000"), feeModelHighHwm);
      expect(perfFeeHighHwm).to.be.gte(0n);
    });

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
  });
});
