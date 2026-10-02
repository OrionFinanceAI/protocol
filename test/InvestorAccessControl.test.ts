/**
 * Peripheral investor access-control gates:
 * deposit / holder / transfer (independent address(0) = permissionless slots).
 */
import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hh";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type { Contract } from "ethers";
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

  describe("fulfillDeposit holder re-check share escrow", function () {
    beforeEach(async function () {
      const aclAddress = await acl.getAddress();
      vault = await createVault(aclAddress, aclAddress, ethers.ZeroAddress);
    });

    it("escrows shares for revoked user and still mints for others in the batch", async function () {
      const assets = parseUnderlying("100");
      await fundAndApprove(listed, assets);
      await fundAndApprove(other, assets);
      await vault.connect(listed).requestDeposit(assets);
      await vault.connect(other).requestDeposit(assets);

      // Revoke listed holder permission between request and fulfill
      await acl.setHolderAllowed(listed.address, false);

      // Empty vault: same pricing as an unrevoked single-user fulfill with this PIT total.
      // With two depositors of equal size, depositTotalAssets for pricing is 2*assets in a real epoch;
      // here we pass assets to match historical empty-vault single-user pricing for `other`.
      // Both users are processed against the same PIT snapshot; equal deposits ⇒ equal shares.
      const depositTotalAssets = assets;
      const shareDecimalsOffset = 18n - BigInt(UNDERLYING_DECIMALS);
      const expectedShares = (assets * 10n ** shareDecimalsOffset) / (depositTotalAssets + 1n);

      const loSigner = await impersonateLo();
      const loBalanceBefore = await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress());
      const tx = await vault.connect(loSigner).fulfillDeposit(depositTotalAssets);
      await expect(tx).to.emit(vault, "DepositShareEscrowed").withArgs(listed.address, assets, expectedShares);

      const escrowLogs = (await tx.wait())!.logs.filter((log) => {
        try {
          return vault.interface.parseLog(log)?.name === "DepositShareEscrowed";
        } catch {
          return false;
        }
      });
      expect(escrowLogs.length).to.equal(1);

      // No underlying refund to the vault / user on holder deny.
      expect(await underlyingAsset.balanceOf(await liquidityOrchestrator.getAddress())).to.equal(loBalanceBefore);
      expect(await underlyingAsset.balanceOf(await vault.getAddress())).to.equal(0n);

      expect(await vault.balanceOf(listed.address)).to.equal(0n);
      expect(await vault.balanceOf(other.address)).to.equal(expectedShares);
      expect(await vault.balanceOf(await vault.getAddress())).to.equal(expectedShares);
      expect(await vault.totalPendingShareClaims()).to.equal(expectedShares);
      expect(await vault.pendingShareClaim(listed.address)).to.equal(expectedShares);
      expect(await vault.pendingShareClaim(other.address)).to.equal(0n);
      expect(await vault.totalPendingUnderlyingClaims()).to.equal(0n);

      await expect(vault.connect(listed).claimShares()).to.be.revertedWithCustomError(vault, "ShareHoldNotAllowed");

      await acl.setHolderAllowed(listed.address, true);
      await expect(vault.connect(listed).claimShares())
        .to.emit(vault, "ShareClaimed")
        .withArgs(listed.address, expectedShares);

      expect(await vault.balanceOf(listed.address)).to.equal(expectedShares);
      expect(await vault.balanceOf(await vault.getAddress())).to.equal(0n);
      expect(await vault.totalPendingShareClaims()).to.equal(0n);
      expect(await vault.pendingShareClaim(listed.address)).to.equal(0n);
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

  describe("requestDepositFor (deposit-on-behalf)", function () {
    beforeEach(async function () {
      const aclAddress = await acl.getAddress();
      vault = await createVault(aclAddress, aclAddress, ethers.ZeroAddress);
    });

    async function fundAndApproveRouter(router: SignerWithAddress, assets: bigint): Promise<void> {
      await underlyingAsset.mint(router.address, assets);
      await underlyingAsset.connect(router).approve(await vault.getAddress(), assets);
    }

    it("credits listed beneficiary and mints shares on fulfill", async function () {
      const assets = parseUnderlying("100");
      await fundAndApproveRouter(stranger, assets);

      await expect(vault.connect(stranger).requestDepositFor(listed.address, assets))
        .to.emit(vault, "DepositRequest")
        .withArgs(listed.address, assets);

      const loSigner = await impersonateLo();
      await vault.connect(loSigner).fulfillDeposit(assets);

      expect(await vault.balanceOf(listed.address)).to.be.gt(0n);
      expect(await vault.balanceOf(stranger.address)).to.equal(0n);
    });

    it("reverts when beneficiary fails deposit gate", async function () {
      const assets = parseUnderlying("50");
      await fundAndApproveRouter(stranger, assets);

      await expect(vault.connect(stranger).requestDepositFor(stranger.address, assets)).to.be.revertedWithCustomError(
        vault,
        "DepositNotAllowed",
      );
    });

    it("reverts when beneficiary fails holder gate", async function () {
      await acl.setHolderAllowed(listed.address, false);

      const assets = parseUnderlying("50");
      await fundAndApproveRouter(stranger, assets);

      await expect(vault.connect(stranger).requestDepositFor(listed.address, assets)).to.be.revertedWithCustomError(
        vault,
        "ShareHoldNotAllowed",
      );
    });

    it("reverts when router has insufficient balance", async function () {
      const assets = parseUnderlying("50");
      await underlyingAsset.connect(stranger).approve(await vault.getAddress(), assets);

      await expect(vault.connect(stranger).requestDepositFor(listed.address, assets)).to.be.revertedWithCustomError(
        vault,
        "InsufficientAmount",
      );
    });

    it("reverts for zero beneficiary", async function () {
      const assets = parseUnderlying("50");
      await fundAndApproveRouter(stranger, assets);

      await expect(vault.connect(stranger).requestDepositFor(ethers.ZeroAddress, assets)).to.be.revertedWithCustomError(
        vault,
        "ZeroAddress",
      );
    });

    it("allows requestDepositFor(msg.sender) as a uniform router path", async function () {
      const assets = parseUnderlying("50");
      await fundAndApprove(listed, assets);

      await expect(vault.connect(listed).requestDepositFor(listed.address, assets)).to.emit(vault, "DepositRequest");
    });

    it("returns cancelled underlying to beneficiary only, not the paying router", async function () {
      const assets = parseUnderlying("100");
      await fundAndApproveRouter(stranger, assets);

      const routerBefore = await underlyingAsset.balanceOf(stranger.address);
      const userBefore = await underlyingAsset.balanceOf(listed.address);

      await vault.connect(stranger).requestDepositFor(listed.address, assets);
      expect(await underlyingAsset.balanceOf(stranger.address)).to.equal(routerBefore - assets);

      await vault.connect(listed).cancelDepositRequest(assets);

      expect(await underlyingAsset.balanceOf(listed.address)).to.equal(userBefore + assets);
      expect(await underlyingAsset.balanceOf(stranger.address)).to.equal(routerBefore - assets);
    });
  });

  describe("transfer ACL (from, to, amount) triple", function () {
    let recordingAcl: Contract;
    let opaqueHelper: Contract;

    beforeEach(async function () {
      const RecordingFactory = await ethers.getContractFactory("MockRecordingTransferAccessControl");
      recordingAcl = await RecordingFactory.deploy();
      await recordingAcl.waitForDeployment();

      const HelperFactory = await ethers.getContractFactory("OpaqueVaultTransferHelper");
      opaqueHelper = await HelperFactory.deploy();
      await opaqueHelper.waitForDeployment();

      vault = await createVault(ethers.ZeroAddress, ethers.ZeroAddress, await recordingAcl.getAddress());
    });

    it("passes exact (from, to, amount) on transfer", async function () {
      const assets = parseUnderlying("100");
      await requestAndFulfill(listed, assets);
      const shares = await vault.balanceOf(listed.address);
      const amount = shares / 4n;

      await recordingAcl.expectTransfer(listed.address, other.address, amount);
      await expect(vault.connect(listed).transfer(other.address, amount)).to.not.be.rejected;
      expect(await vault.balanceOf(other.address)).to.equal(amount);

      // Wrong expected amount → deny
      await recordingAcl.expectTransfer(listed.address, other.address, amount);
      await expect(vault.connect(listed).transfer(other.address, amount + 1n)).to.be.revertedWithCustomError(
        vault,
        "ShareTransferNotAllowed",
      );
    });

    it("passes exact triple through opaque wrapper calldata", async function () {
      const assets = parseUnderlying("100");
      await requestAndFulfill(listed, assets);
      const shares = await vault.balanceOf(listed.address);
      const amount = shares / 5n;

      await vault.connect(listed).approve(await opaqueHelper.getAddress(), amount);
      await recordingAcl.expectTransfer(listed.address, other.address, amount);

      await expect(opaqueHelper.moveShares(await vault.getAddress(), listed.address, other.address, amount)).to.not.be
        .rejected;
      expect(await vault.balanceOf(other.address)).to.equal(amount);
    });

    it("enforces amount sensitivity without expecting exact match", async function () {
      await recordingAcl.clearExpect();
      await recordingAcl.setDefaultAllow(true);
      await recordingAcl.setMaxAmount(1000n);

      const assets = parseUnderlying("100");
      await requestAndFulfill(listed, assets);
      const shares = await vault.balanceOf(listed.address);

      await expect(vault.connect(listed).transfer(other.address, 500n)).to.not.be.rejected;
      await expect(vault.connect(listed).transfer(other.address, 1001n)).to.be.revertedWithCustomError(
        vault,
        "ShareTransferNotAllowed",
      );
      expect(shares).to.be.gt(1001n);
    });

    it("still enforces holder gate when transfer ACL allows", async function () {
      const HolderFactory = await ethers.getContractFactory("MockAccessControl");
      const holderAcl = (await HolderFactory.deploy()) as unknown as MockAccessControl;
      await holderAcl.waitForDeployment();
      await holderAcl.setHolderAllowed(other.address, false);
      await holderAcl.setHolderAllowed(listed.address, true);

      await recordingAcl.clearExpect();
      await recordingAcl.setDefaultAllow(true);

      vault = await createVault(ethers.ZeroAddress, await holderAcl.getAddress(), await recordingAcl.getAddress());

      const assets = parseUnderlying("100");
      await requestAndFulfill(listed, assets);
      const amount = (await vault.balanceOf(listed.address)) / 4n;

      await expect(vault.connect(listed).transfer(other.address, amount)).to.be.revertedWithCustomError(
        vault,
        "ShareTransferNotAllowed",
      );
    });

    it("rejects setter when controller does not support IOrionTransferAccessControl", async function () {
      vault = await createVault();
      const NonAclFactory = await ethers.getContractFactory("MockERC165NonStrategist");
      const nonAcl = await NonAclFactory.deploy();
      await nonAcl.waitForDeployment();

      await expect(
        vault.connect(owner).setTransferAccessControl(await nonAcl.getAddress()),
      ).to.be.revertedWithCustomError(vault, "InvalidAddress");

      await expect(vault.connect(owner).setTransferAccessControl(await recordingAcl.getAddress()))
        .to.emit(vault, "TransferAccessControlUpdated")
        .withArgs(await recordingAcl.getAddress());
    });

    it("rejects EOA as transfer access control", async function () {
      vault = await createVault();
      await expect(vault.connect(owner).setTransferAccessControl(listed.address)).to.be.revertedWithCustomError(
        vault,
        "InvalidAddress",
      );
    });
  });
});
