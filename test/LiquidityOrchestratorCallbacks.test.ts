import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hh";
import { deployUUPSProxy } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";
import type {
  LiquidityOrchestratorBufferHarness,
  MockUnderlyingAsset,
  OrionConfig,
  OrionTransparentVault,
  PriceAdapterRegistry,
  TransparentVaultFactory,
} from "../typechain-types";

describe("LiquidityOrchestrator callbacks and protocol fee claims", function () {
  before(async function () {
    await resetNetwork();
  });

  async function impersonate(address: string) {
    await networkHelpers.impersonateAccount(address);
    await networkHelpers.setBalance(address, ethers.parseEther("1"));
    return ethers.getSigner(address);
  }

  async function deployFixture() {
    const [owner, manager, strategist, stranger, recipient] = await ethers.getSigners();

    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAsset = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset;
    await underlyingAsset.waitForDeployment();

    const orionConfig = await deployUUPSProxy<OrionConfig>(
      "OrionConfig",
      [owner.address, await underlyingAsset.getAddress()],
      owner,
    );

    const priceAdapterRegistry = await deployUUPSProxy<PriceAdapterRegistry>(
      "PriceAdapterRegistry",
      [owner.address, await orionConfig.getAddress()],
      owner,
    );
    await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

    const SP1VerifierGatewayFactory = await ethers.getContractFactory("SP1VerifierGateway");
    const sp1VerifierGateway = await SP1VerifierGatewayFactory.deploy(owner.address);
    await sp1VerifierGateway.waitForDeployment();
    const SP1VerifierFactory = await ethers.getContractFactory("SP1Verifier");
    const sp1Verifier = await SP1VerifierFactory.deploy();
    await sp1Verifier.waitForDeployment();
    await sp1VerifierGateway.addRoute(await sp1Verifier.getAddress());

    const vKey = "0x007ccff4696ddd1d62fec2a106aa50309ba0fdee8fc2bcbc9c0b5ea68fe200f3";
    const harness = await deployUUPSProxy<LiquidityOrchestratorBufferHarness>(
      "LiquidityOrchestratorBufferHarness",
      [owner.address, await orionConfig.getAddress(), owner.address, await sp1VerifierGateway.getAddress(), vKey],
      owner,
    );
    await orionConfig.setLiquidityOrchestrator(await harness.getAddress());

    const VaultImplFactory = await ethers.getContractFactory("OrionTransparentVault");
    const vaultImpl = await VaultImplFactory.deploy();
    await vaultImpl.waitForDeployment();
    const BeaconFactory = await ethers.getContractFactory("OrionUpgradeableBeacon");
    const vaultBeacon = await BeaconFactory.deploy(await vaultImpl.getAddress(), owner.address);
    await vaultBeacon.waitForDeployment();

    const transparentVaultFactory = await deployUUPSProxy<TransparentVaultFactory>(
      "TransparentVaultFactory",
      [owner.address, await orionConfig.getAddress(), await vaultBeacon.getAddress()],
      owner,
    );
    await orionConfig.setVaultFactory(await transparentVaultFactory.getAddress());
    await orionConfig.addWhitelistedManager(manager.address);

    const tx = await transparentVaultFactory
      .connect(manager)
      .createVault(
        strategist.address,
        "Callback Vault",
        "CV",
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
    const vaultAddress = transparentVaultFactory.interface.parseLog(log!)?.args?.[0] as string;
    const vault = (await ethers.getContractAt(
      "OrionTransparentVault",
      vaultAddress,
    )) as unknown as OrionTransparentVault;

    return {
      owner,
      manager,
      stranger,
      recipient,
      underlyingAsset,
      orionConfig,
      harness,
      vault,
      vaultAddress,
    };
  }

  describe("claimProtocolFees", function () {
    it("Should reject non-owner, zero amount, and over-pending claims", async function () {
      const { harness, stranger, owner } = await networkHelpers.loadFixture(deployFixture);

      await expect(harness.connect(stranger).claimProtocolFees(1)).to.be.revertedWithCustomError(
        harness,
        "OwnableUnauthorizedAccount",
      );

      await expect(harness.connect(owner).claimProtocolFees(0)).to.be.revertedWithCustomError(
        harness,
        "AmountMustBeGreaterThanZero",
      );

      await harness.h_setPendingProtocolFees(10n);
      await expect(harness.connect(owner).claimProtocolFees(11n)).to.be.revertedWithCustomError(
        harness,
        "InsufficientAmount",
      );
    });

    it("Should let owner claim pending protocol fees and emit ProtocolFeesClaimed", async function () {
      const { harness, owner, underlyingAsset } = await networkHelpers.loadFixture(deployFixture);
      const amount = ethers.parseUnits("40", 6);

      await harness.h_setPendingProtocolFees(amount);
      await underlyingAsset.mint(await harness.getAddress(), amount);

      const before = await underlyingAsset.balanceOf(owner.address);
      await expect(harness.connect(owner).claimProtocolFees(amount))
        .to.emit(harness, "ProtocolFeesClaimed")
        .withArgs(amount);

      expect(await harness.pendingProtocolFees()).to.equal(0);
      expect(await underlyingAsset.balanceOf(owner.address)).to.equal(before + amount);
    });
  });

  describe("transferVaultFees / transferRedemptionFunds", function () {
    it("Should reject non-vault callers", async function () {
      const { harness, stranger, recipient } = await networkHelpers.loadFixture(deployFixture);

      await expect(harness.connect(stranger).transferVaultFees(1)).to.be.revertedWithCustomError(
        harness,
        "NotAuthorized",
      );
      await expect(
        harness.connect(stranger).transferRedemptionFunds(recipient.address, 1),
      ).to.be.revertedWithCustomError(harness, "NotAuthorized");
    });

    it("Should allow impersonated registered vault to pull fees and redemption funds", async function () {
      const { harness, vaultAddress, manager, recipient, underlyingAsset } =
        await networkHelpers.loadFixture(deployFixture);

      const fee = ethers.parseUnits("7", 6);
      const redeem = ethers.parseUnits("13", 6);
      await underlyingAsset.mint(await harness.getAddress(), fee + redeem);

      const vaultSigner = await impersonate(vaultAddress);
      const managerBefore = await underlyingAsset.balanceOf(manager.address);
      const recipientBefore = await underlyingAsset.balanceOf(recipient.address);

      await harness.connect(vaultSigner).transferVaultFees(fee);
      expect(await underlyingAsset.balanceOf(manager.address)).to.equal(managerBefore + fee);

      await harness.connect(vaultSigner).transferRedemptionFunds(recipient.address, redeem);
      expect(await underlyingAsset.balanceOf(recipient.address)).to.equal(recipientBefore + redeem);
    });
  });
});
