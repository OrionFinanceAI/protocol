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
