/**
 * Peripheral investor access-control gates:
 * deposit / holder / transfer (independent address(0) = permissionless slots).
 */
import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hh";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  MockAccessControl,
  MockUnderlyingAsset,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  OrionTransparentVault,
} from "../typechain-types";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";

describe("Investor access-control gates", function () {
  let liquidityOrchestrator: LiquidityOrchestrator;
  let transparentVaultFactory: TransparentVaultFactory;
  let underlyingAsset: MockUnderlyingAsset;
  let vault: OrionTransparentVault;
  let acl: MockAccessControl;

  let owner: SignerWithAddress;
  let strategist: SignerWithAddress;
  let listed: SignerWithAddress;
  let other: SignerWithAddress;
  let stranger: SignerWithAddress;

  const UNDERLYING_DECIMALS = 6;

  function parseUnderlying(amount: string): bigint {
    return ethers.parseUnits(amount, UNDERLYING_DECIMALS);
  }

  async function impersonateLo() {
    const loAddress = await liquidityOrchestrator.getAddress();
    await networkHelpers.impersonateAccount(loAddress);
    await networkHelpers.setBalance(loAddress, ethers.parseEther("1"));
    return ethers.getSigner(loAddress);
  }

  async function createVault(
    depositAcl: string = ethers.ZeroAddress,
    holderAcl: string = ethers.ZeroAddress,
    transferAcl: string = ethers.ZeroAddress,
  ): Promise<OrionTransparentVault> {
    const tx = await transparentVaultFactory
      .connect(owner)
      .createVault(strategist.address, "ACL Vault", "ACLV", 0, 0, 0, depositAcl, holderAcl, transferAcl);
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

  async function fundAndApprove(account: SignerWithAddress, assets: bigint): Promise<void> {
    await underlyingAsset.mint(account.address, assets);
    await underlyingAsset.connect(account).approve(await vault.getAddress(), assets);
  }

  async function requestAndFulfill(account: SignerWithAddress, assets: bigint): Promise<void> {
    await fundAndApprove(account, assets);
    await vault.connect(account).requestDeposit(assets);
    const loSigner = await impersonateLo();
    await vault.connect(loSigner).fulfillDeposit(assets);
  }

  async function allowAllGates(account: string): Promise<void> {
    await acl.setDepositAllowed(account, true);
    await acl.setHolderAllowed(account, true);
    await acl.setTransferAllowed(account, true);
  }

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    [owner, strategist, listed, other, stranger] = await ethers.getSigners();

    const protocol = await deployUpgradeableProtocol(owner);
    liquidityOrchestrator = protocol.liquidityOrchestrator;
    transparentVaultFactory = protocol.transparentVaultFactory;
    underlyingAsset = protocol.underlyingAsset;

    const AclFactory = await ethers.getContractFactory("MockAccessControl");
    acl = (await AclFactory.deploy()) as unknown as MockAccessControl;
    await acl.waitForDeployment();
    await allowAllGates(listed.address);
    await allowAllGates(other.address);
  });

  describe("permissionless (all gates unset)", function () {
    beforeEach(async function () {
      vault = await createVault(ethers.ZeroAddress);
    });

    it("allows anyone to requestDeposit and transfer shares", async function () {
      const assets = parseUnderlying("100");
      await requestAndFulfill(stranger, assets);

      const shares = await vault.balanceOf(stranger.address);
      expect(shares).to.be.gt(0n);

      await vault.connect(stranger).transfer(listed.address, shares / 2n);
      expect(await vault.balanceOf(listed.address)).to.equal(shares / 2n);
    });
  });

  describe("deposit gate only", function () {
    beforeEach(async function () {
      vault = await createVault(await acl.getAddress());
    });

    it("reverts requestDeposit for non-listed and allows listed", async function () {
      const assets = parseUnderlying("50");
      await fundAndApprove(stranger, assets);
      await expect(vault.connect(stranger).requestDeposit(assets)).to.be.revertedWithCustomError(
        vault,
        "DepositNotAllowed",
      );

      await fundAndApprove(listed, assets);
      await expect(vault.connect(listed).requestDeposit(assets)).to.emit(vault, "DepositRequest");
    });

    it("leaves share transfers unrestricted when holder/transfer gates are unset", async function () {
      const assets = parseUnderlying("100");
      await requestAndFulfill(listed, assets);
      const shares = await vault.balanceOf(listed.address);

      await expect(vault.connect(listed).transfer(stranger.address, shares / 2n)).to.not.be.rejected;
      expect(await vault.balanceOf(stranger.address)).to.equal(shares / 2n);
    });

    it("returns maxDeposit 0 for non-listed", async function () {
      expect(await vault.maxDeposit(listed.address)).to.equal(ethers.MaxUint256);
      expect(await vault.maxDeposit(stranger.address)).to.equal(0n);
      expect(await vault.maxMint(stranger.address)).to.equal(0n);
    });
  });

  describe("holder + transfer gates", function () {
    beforeEach(async function () {
      const aclAddress = await acl.getAddress();
      vault = await createVault(aclAddress, aclAddress, aclAddress);
    });

    it("allows listed → listed transfer and reverts listed → non-listed", async function () {
      const assets = parseUnderlying("100");
      await requestAndFulfill(listed, assets);
      const shares = await vault.balanceOf(listed.address);

      await expect(vault.connect(listed).transfer(other.address, shares / 4n)).to.not.be.rejected;

      await expect(vault.connect(listed).transfer(stranger.address, shares / 4n)).to.be.revertedWithCustomError(
        vault,
        "ShareTransferNotAllowed",
      );
    });

    it("reverts non-listed → listed transfer", async function () {
      // other receives shares while listed, then loses transfer permission so the outbound transfer reverts.
      const assets = parseUnderlying("100");
      await requestAndFulfill(listed, assets);
      const half = (await vault.balanceOf(listed.address)) / 2n;
      await vault.connect(listed).transfer(other.address, half);

      await acl.setTransferAllowed(other.address, false);
      await expect(vault.connect(other).transfer(listed.address, half)).to.be.revertedWithCustomError(
        vault,
        "ShareTransferNotAllowed",
      );
    });

    it("allows redeem request/cancel/fulfill with share gates set (vault exemption)", async function () {
      const assets = parseUnderlying("100");
      await requestAndFulfill(listed, assets);
      const shares = await vault.balanceOf(listed.address);

      await vault.connect(listed).approve(await vault.getAddress(), shares);
      await expect(vault.connect(listed).requestRedeem(shares)).to.emit(vault, "RedeemRequest");
      expect(await vault.balanceOf(await vault.getAddress())).to.equal(shares);

      await vault.connect(listed).cancelRedeemRequest(shares);
      expect(await vault.balanceOf(listed.address)).to.equal(shares);

      await vault.connect(listed).approve(await vault.getAddress(), shares);
      await vault.connect(listed).requestRedeem(shares);

      const loSigner = await impersonateLo();
      // Fund LO so redemption payout can succeed
      await underlyingAsset.mint(await liquidityOrchestrator.getAddress(), assets);
      await expect(vault.connect(loSigner).fulfillRedeem(assets)).to.not.be.rejected;
      expect(await vault.balanceOf(listed.address)).to.equal(0n);
    });

    it("returns maxDeposit 0 when holder gate denies even if deposit gate allows", async function () {
      await acl.setHolderAllowed(listed.address, false);
      expect(await vault.maxDeposit(listed.address)).to.equal(0n);
    });
  });

  describe("manager setters", function () {
    beforeEach(async function () {
      vault = await createVault(ethers.ZeroAddress);
    });

    it("allows manager to set and clear each gate independently", async function () {
      const aclAddress = await acl.getAddress();

      await expect(vault.connect(owner).setDepositAccessControl(aclAddress))
        .to.emit(vault, "DepositAccessControlUpdated")
        .withArgs(aclAddress);
      await expect(vault.connect(owner).setHolderAccessControl(aclAddress))
        .to.emit(vault, "HolderAccessControlUpdated")
        .withArgs(aclAddress);
      await expect(vault.connect(owner).setTransferAccessControl(aclAddress))
        .to.emit(vault, "TransferAccessControlUpdated")
        .withArgs(aclAddress);

      expect(await vault.depositAccessControl()).to.equal(aclAddress);
      expect(await vault.holderAccessControl()).to.equal(aclAddress);
      expect(await vault.transferAccessControl()).to.equal(aclAddress);

      await vault.connect(owner).setHolderAccessControl(ethers.ZeroAddress);
      await vault.connect(owner).setTransferAccessControl(ethers.ZeroAddress);
      expect(await vault.holderAccessControl()).to.equal(ethers.ZeroAddress);
      expect(await vault.transferAccessControl()).to.equal(ethers.ZeroAddress);
      expect(await vault.depositAccessControl()).to.equal(aclAddress);
    });

    it("reverts when non-manager sets share gates", async function () {
      await expect(vault.connect(listed).setHolderAccessControl(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        vault,
        "NotAuthorized",
      );
      await expect(vault.connect(listed).setTransferAccessControl(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        vault,
        "NotAuthorized",
      );
    });
  });

  describe("fulfillDeposit holder re-check escrow", function () {
    beforeEach(async function () {
      const aclAddress = await acl.getAddress();
      vault = await createVault(aclAddress, aclAddress, ethers.ZeroAddress);
    });

    it("escrows underlying for revoked user and still mints for others in the batch", async function () {
      const assets = parseUnderlying("100");
      await fundAndApprove(listed, assets);
      await fundAndApprove(other, assets);
      await vault.connect(listed).requestDeposit(assets);
      await vault.connect(other).requestDeposit(assets);

      // Revoke listed holder permission between request and fulfill
      await acl.setHolderAllowed(listed.address, false);

      // Empty vault: same pricing as an unrevoked single-user fulfill with this PIT total.
      const depositTotalAssets = assets;
      const shareDecimalsOffset = 18n - BigInt(UNDERLYING_DECIMALS);
      const expectedOtherShares = (assets * 10n ** shareDecimalsOffset) / (depositTotalAssets + 1n);

      const loSigner = await impersonateLo();
      const tx = await vault.connect(loSigner).fulfillDeposit(depositTotalAssets);
      await expect(tx).to.emit(vault, "DepositFulfillmentFailed").withArgs(listed.address, assets);

      const failedLogs = (await tx.wait())!.logs.filter((log) => {
        try {
          return vault.interface.parseLog(log)?.name === "DepositFulfillmentFailed";
        } catch {
          return false;
        }
      });
      expect(failedLogs.length).to.equal(1);

      expect(await vault.balanceOf(listed.address)).to.equal(0n);
      expect(await vault.balanceOf(other.address)).to.equal(expectedOtherShares);
      expect(await vault.totalPendingUnderlyingClaims()).to.equal(assets);

      const before = await underlyingAsset.balanceOf(listed.address);
      await vault.connect(listed).claimUnderlying();
      expect(await underlyingAsset.balanceOf(listed.address)).to.equal(before + assets);
      expect(await vault.totalPendingUnderlyingClaims()).to.equal(0n);
    });
  });

  describe("requestDeposit also checks holder gate", function () {
    it("reverts when deposit gate allows but holder gate denies", async function () {
      vault = await createVault(ethers.ZeroAddress);
      await vault.connect(owner).setHolderAccessControl(await acl.getAddress());

      const assets = parseUnderlying("50");
      await fundAndApprove(stranger, assets);
      await expect(vault.connect(stranger).requestDeposit(assets)).to.be.revertedWithCustomError(
        vault,
        "ShareHoldNotAllowed",
      );

      await fundAndApprove(listed, assets);
      await expect(vault.connect(listed).requestDeposit(assets)).to.emit(vault, "DepositRequest");
    });
  });
});
