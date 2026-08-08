import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hh";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";
import type {
  OrionTransparentVault,
  MockUnderlyingAsset,
  LiquidityOrchestrator,
  OrionConfig,
} from "../typechain-types";

describe("OrionVault LO auth and fee claim edges", function () {
  before(async function () {
    await resetNetwork();
  });

  async function impersonateOrchestrator(orchestratorAddress: string) {
    await networkHelpers.impersonateAccount(orchestratorAddress);
    await networkHelpers.setBalance(orchestratorAddress, ethers.parseEther("1"));
    return ethers.getSigner(orchestratorAddress);
  }

  async function deployFixture() {
    const [owner, manager, strategist, stranger] = await ethers.getSigners();
    const deployed = await deployUpgradeableProtocol(owner);
    const { underlyingAsset, transparentVaultFactory, liquidityOrchestrator, orionConfig } = deployed;

    await orionConfig.connect(owner).addWhitelistedManager(manager.address);

    const tx = await transparentVaultFactory
      .connect(manager)
      .createVault(strategist.address, "Auth Vault", "AV", 0, 0, 0, ethers.ZeroAddress);
    const receipt = await tx.wait();
    const log = receipt?.logs.find((l) => {
      try {
        return transparentVaultFactory.interface.parseLog(l)?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const vaultAddress = transparentVaultFactory.interface.parseLog(log!)?.args?.[0] as string;
    const vault = (await ethers.getContractAt(
      "OrionTransparentVault",
      vaultAddress,
    )) as unknown as OrionTransparentVault;

    const loAddress = await liquidityOrchestrator.getAddress();
    const loSigner = await impersonateOrchestrator(loAddress);

    return {
      owner,
      manager,
      stranger,
      vault,
      underlyingAsset: underlyingAsset as MockUnderlyingAsset,
      liquidityOrchestrator: liquidityOrchestrator as LiquidityOrchestrator,
      orionConfig: orionConfig as OrionConfig,
      loAddress,
      loSigner,
    };
  }

  describe("onlyLiquidityOrchestrator", function () {
    it("Should reject fulfillDeposit, fulfillRedeem, accrueVaultFees, updateVaultState from non-LO", async function () {
      const { vault, stranger } = await networkHelpers.loadFixture(deployFixture);

      await expect(vault.connect(stranger).fulfillDeposit(0)).to.be.revertedWithCustomError(vault, "NotAuthorized");
      await expect(vault.connect(stranger).fulfillRedeem(0)).to.be.revertedWithCustomError(vault, "NotAuthorized");
      await expect(vault.connect(stranger).accrueVaultFees(1, 0)).to.be.revertedWithCustomError(vault, "NotAuthorized");
      await expect(vault.connect(stranger).updateVaultState([], [], 0)).to.be.revertedWithCustomError(
        vault,
        "NotAuthorized",
      );
    });

    it("Should let impersonated LO accrue vault fees and emit VaultFeesAccrued", async function () {
      const { vault, loSigner } = await networkHelpers.loadFixture(deployFixture);

      const managementFee = ethers.parseUnits("10", 6);
      const performanceFee = ethers.parseUnits("5", 6);

      await expect(vault.connect(loSigner).accrueVaultFees(managementFee, performanceFee))
        .to.emit(vault, "VaultFeesAccrued")
        .withArgs(managementFee, performanceFee);

      expect(await vault.pendingVaultFees()).to.equal(managementFee + performanceFee);
    });
  });

  describe("claimVaultFees", function () {
    it("Should reject non-manager claims", async function () {
      const { vault, stranger, loSigner } = await networkHelpers.loadFixture(deployFixture);
      await vault.connect(loSigner).accrueVaultFees(ethers.parseUnits("1", 6), 0);

      await expect(vault.connect(stranger).claimVaultFees(1)).to.be.revertedWithCustomError(vault, "NotAuthorized");
    });

    it("Should reject zero and over-pending amounts", async function () {
      const { vault, manager, loSigner } = await networkHelpers.loadFixture(deployFixture);
      const pending = ethers.parseUnits("10", 6);
      await vault.connect(loSigner).accrueVaultFees(pending, 0);

      await expect(vault.connect(manager).claimVaultFees(0)).to.be.revertedWithCustomError(
        vault,
        "AmountMustBeGreaterThanZero",
      );
      await expect(vault.connect(manager).claimVaultFees(pending + 1n)).to.be.revertedWithCustomError(
        vault,
        "InsufficientAmount",
      );
    });

    it("Should let manager claim accrued fees from LO and clear pending", async function () {
      const { vault, manager, loSigner, loAddress, underlyingAsset } = await networkHelpers.loadFixture(deployFixture);

      const fee = ethers.parseUnits("25", 6);
      await vault.connect(loSigner).accrueVaultFees(fee, 0);
      await underlyingAsset.mint(loAddress, fee);

      const managerBefore = await underlyingAsset.balanceOf(manager.address);

      await expect(vault.connect(manager).claimVaultFees(fee))
        .to.emit(vault, "VaultFeesClaimed")
        .withArgs(manager.address, fee);

      expect(await vault.pendingVaultFees()).to.equal(0);
      expect(await underlyingAsset.balanceOf(manager.address)).to.equal(managerBefore + fee);
    });
  });
});
