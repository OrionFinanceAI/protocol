/**
 * Push redemption via transferRedemptionFunds + safeTransfer(user) is isolated when
 * the underlying denylists the recipient. Shares are burned, USDC is escrowed on the
 * vault, and the user claims after the denylist is cleared. Epoch fulfillRedeem does
 * not revert.
 */
import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hh";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  MockBlacklistUnderlying,
  MockUnderlyingAsset,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  OrionTransparentVault,
} from "../typechain-types";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";

describe("Redemption recipient denylist", function () {
  let liquidityOrchestrator: LiquidityOrchestrator;
  let transparentVaultFactory: TransparentVaultFactory;
  let underlyingAsset: MockBlacklistUnderlying;
  let vault: OrionTransparentVault;

  let owner: SignerWithAddress;
  let strategist: SignerWithAddress;
  let user: SignerWithAddress;
  let other: SignerWithAddress;

  const UNDERLYING_DECIMALS = 6;
  const MAX_BATCH = 150;

  function parseUnderlying(amount: string): bigint {
    return ethers.parseUnits(amount, UNDERLYING_DECIMALS);
  }

  async function impersonateLo() {
    const loAddress = await liquidityOrchestrator.getAddress();
    await networkHelpers.impersonateAccount(loAddress);
    await networkHelpers.setBalance(loAddress, ethers.parseEther("1"));
    return ethers.getSigner(loAddress);
  }

  async function createVault(): Promise<OrionTransparentVault> {
    const tx = await transparentVaultFactory
      .connect(owner)
      .createVault(
        strategist.address,
        "Denylist Vault",
        "DV",
        0,
        0,
        0,
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
    const vaultAddress = transparentVaultFactory.interface.parseLog(log!)?.args[0] as string;
    return (await ethers.getContractAt("OrionTransparentVault", vaultAddress)) as unknown as OrionTransparentVault;
  }

  async function requestDeposit(account: SignerWithAddress, assets: bigint): Promise<void> {
    await underlyingAsset.mint(account.address, assets);
    await underlyingAsset.connect(account).approve(await vault.getAddress(), assets);
    await vault.connect(account).requestDeposit(assets);
  }

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    [owner, strategist, user, other] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("MockBlacklistUnderlying");
    const deployed = await Factory.deploy(UNDERLYING_DECIMALS);
    await deployed.waitForDeployment();
    underlyingAsset = deployed as unknown as MockBlacklistUnderlying;

    const protocol = await deployUpgradeableProtocol(owner, underlyingAsset as unknown as MockUnderlyingAsset);
    liquidityOrchestrator = protocol.liquidityOrchestrator;
    transparentVaultFactory = protocol.transparentVaultFactory;

    vault = await createVault();
  });

  it("does not revert fulfillRedeem when the redeemer is denylisted; user claims after unlist", async function () {
    const depositAssets = parseUnderlying("100000");
    await requestDeposit(user, depositAssets);

    const loSigner = await impersonateLo();
    await vault.connect(loSigner).fulfillDeposit(depositAssets);
    await vault.connect(loSigner).updateVaultState([await underlyingAsset.getAddress()], [0n], depositAssets);
    await networkHelpers.stopImpersonatingAccount(await liquidityOrchestrator.getAddress());

    const sharesAfterDeposit = await vault.balanceOf(user.address);
    const redeemShares = sharesAfterDeposit / 2n;
    expect(redeemShares).to.be.gt(0n);

    await vault.connect(user).approve(await vault.getAddress(), redeemShares);
    await vault.connect(user).requestRedeem(redeemShares);

    const pendingAfterRequest = await vault.pendingRedeem(MAX_BATCH);
    const userBalAfterRequest = await vault.balanceOf(user.address);
    const supplyAfterRequest = await vault.totalSupply();
    expect(pendingAfterRequest).to.equal(redeemShares);

    await underlyingAsset.setBlacklisted(user.address, true);

    const redeemTotalAssets = depositAssets - parseUnderlying("5000");
    const loSigner2 = await impersonateLo();
    await expect(vault.connect(loSigner2).fulfillRedeem(redeemTotalAssets)).to.emit(vault, "RedemptionFailed");
    await networkHelpers.stopImpersonatingAccount(await liquidityOrchestrator.getAddress());

    expect(await vault.pendingRedeem(MAX_BATCH)).to.equal(0n);
    expect(await vault.balanceOf(user.address)).to.equal(userBalAfterRequest);
    expect(await vault.totalSupply()).to.equal(supplyAfterRequest - redeemShares);

    const claimed = await vault.totalPendingUnderlyingClaims();
    expect(claimed).to.be.gt(0n);
    expect(await underlyingAsset.balanceOf(await vault.getAddress())).to.equal(claimed);

    await expect(vault.connect(user).claimUnderlying()).to.be.revertedWithCustomError(
      underlyingAsset,
      "RecipientBlacklisted",
    );

    await underlyingAsset.setBlacklisted(user.address, false);
    const before = await underlyingAsset.balanceOf(user.address);
    await expect(vault.connect(user).claimUnderlying())
      .to.emit(vault, "RedemptionClaimed")
      .withArgs(user.address, claimed);
    expect(await underlyingAsset.balanceOf(user.address)).to.equal(before + claimed);
    expect(await vault.totalPendingUnderlyingClaims()).to.equal(0n);
    await expect(vault.connect(user).claimUnderlying()).to.be.revertedWithCustomError(vault, "InsufficientAmount");
  });

  it("pays a clean recipient in the same batch while escrowing the denylisted one", async function () {
    const depositAssets = parseUnderlying("100000");
    await requestDeposit(user, depositAssets);
    await requestDeposit(other, depositAssets);

    const totalAssets = depositAssets * 2n;
    const loSigner = await impersonateLo();
    await vault.connect(loSigner).fulfillDeposit(totalAssets);
    await vault.connect(loSigner).updateVaultState([await underlyingAsset.getAddress()], [0n], totalAssets);
    await networkHelpers.stopImpersonatingAccount(await liquidityOrchestrator.getAddress());

    const userShares = await vault.balanceOf(user.address);
    const otherShares = await vault.balanceOf(other.address);
    await vault.connect(user).approve(await vault.getAddress(), userShares);
    await vault.connect(other).approve(await vault.getAddress(), otherShares);
    await vault.connect(user).requestRedeem(userShares);
    await vault.connect(other).requestRedeem(otherShares);

    await underlyingAsset.setBlacklisted(user.address, true);

    const loSigner2 = await impersonateLo();
    await vault.connect(loSigner2).fulfillRedeem(totalAssets);
    await networkHelpers.stopImpersonatingAccount(await liquidityOrchestrator.getAddress());

    expect(await vault.pendingRedeem(MAX_BATCH)).to.equal(0n);
    expect(await vault.totalPendingUnderlyingClaims()).to.be.gt(0n);
    expect(await underlyingAsset.balanceOf(other.address)).to.be.gt(0n);
    expect(await underlyingAsset.balanceOf(user.address)).to.equal(0n);
  });
});
