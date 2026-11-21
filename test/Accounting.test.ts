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

const FeeType = {
  ABSOLUTE: 0,
  SOFT_HURDLE: 1,
  HARD_HURDLE: 2,
  HIGH_WATER_MARK: 3,
  HURDLE_HWM: 4,
} as const;

describe("OrionVault Accounting", function () {
  let orionConfig: OrionConfig;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let transparentVaultFactory: TransparentVaultFactory;
  let underlyingAsset: MockUnderlyingAsset;
  let vault: OrionTransparentVault;

  let owner: SignerWithAddress;
  let strategist: SignerWithAddress;
  let user: SignerWithAddress;
  let other: SignerWithAddress;

  /** Floor / ceil of `assets * (supply + OFFSET) / (pitAssets + 1)` (Orion PIT mint formula). */
  function pitSharesFloorCeil(assets: bigint, pitAssets: bigint, supply: bigint): { floor: bigint; ceil: bigint } {
    const numerator = assets * (supply + OFFSET);
    const denominator = pitAssets + 1n;
    const floor = numerator / denominator;
    const ceil = floor + (numerator % denominator === 0n ? 0n : 1n);
    return { floor, ceil };
  }

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
        ethers.ZeroAddress,
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
    [owner, strategist, user, other] = await ethers.getSigners();

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
    await underlyingAsset.mint(other.address, parseUnderlying("1000000"));
    await underlyingAsset.connect(other).approve(await vault.getAddress(), parseUnderlying("1000000"));
  });

  describe("convertToSharesWithPITTotalAssets / fulfillDeposit Floor", function () {
    it("1-wei queued deposit mints 0 shares under high NAV (Pods ceil would mint 1)", async function () {
      const seedAssets = parseUnderlying("1000");
      await vault.connect(user).requestDeposit(seedAssets);
      // Empty-vault mint then inflate NAV so 1 * (supply + OFFSET) < (pitAssets + 1).
      await setVaultStateWithFulfilledDeposit(vault, 0n, seedAssets);

      const snapSupply = await vault.totalSupply();
      const highNav = snapSupply + OFFSET; // floor(1 * (S+OFFSET) / (highNav+1)) == 0
      const loAddress = await liquidityOrchestrator.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [loAddress]);
      await ethers.provider.send("hardhat_setBalance", [loAddress, ethers.toQuantity(ethers.parseEther("1"))]);
      const loSigner = await ethers.getSigner(loAddress);
      await vault.connect(loSigner).updateVaultState([await underlyingAsset.getAddress()], [0n], highNav);

      const dust = 1n;
      const { floor, ceil } = pitSharesFloorCeil(dust, highNav, snapSupply);
      expect(floor).to.equal(0n);
      expect(ceil).to.equal(1n);

      const sharesBefore = await vault.balanceOf(other.address);
      await vault.connect(other).requestDeposit(dust);
      await vault.connect(loSigner).fulfillDeposit(highNav);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [loAddress]);

      expect(await vault.balanceOf(other.address)).to.equal(sharesBefore);
      expect(await vault.pendingDepositOf(other.address)).to.equal(0n);
    });

    it("fulfillDeposit mints Floor shares, never Ceil, when remainder is nonzero", async function () {
      const seedAssets = parseUnderlying("100000");
      await vault.connect(user).requestDeposit(seedAssets);
      await setVaultStateWithFulfilledDeposit(vault, 0n, seedAssets);

      // Skew PIT total assets so amount * (supply + OFFSET) is not divisible by (pit + 1).
      const pitAssets = seedAssets + 1n;
      const loAddress = await liquidityOrchestrator.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [loAddress]);
      await ethers.provider.send("hardhat_setBalance", [loAddress, ethers.toQuantity(ethers.parseEther("1"))]);
      const loSigner = await ethers.getSigner(loAddress);
      await vault.connect(loSigner).updateVaultState([await underlyingAsset.getAddress()], [0n], pitAssets);

      const snapSupply = await vault.totalSupply();
      const amount = parseUnderlying("3");
      const { floor, ceil } = pitSharesFloorCeil(amount, pitAssets, snapSupply);
      expect(floor).to.be.gt(0n);
      expect(ceil).to.equal(floor + 1n);

      const sharesBefore = await vault.balanceOf(other.address);
      await vault.connect(other).requestDeposit(amount);
      await vault.connect(loSigner).fulfillDeposit(pitAssets);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [loAddress]);

      const deltaShares = (await vault.balanceOf(other.address)) - sharesBefore;
      expect(deltaShares).to.equal(floor);
      expect(deltaShares).to.be.lt(ceil);
    });
  });

  describe("convertToAssetsWithPITTotalAssets", function () {
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

  describe("vaultFee, _performanceFeeAmount, _performanceFeeBenchmark, _getHurdlePrice", function () {
    beforeEach(async function () {
      const depositAssets = parseUnderlying("100000");
      await vault.connect(user).requestDeposit(depositAssets);
      await setVaultStateWithFulfilledDeposit(vault, depositAssets, depositAssets);
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
  });
});
