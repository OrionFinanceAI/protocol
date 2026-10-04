/**
 * CEI hardening regression PoCs (CHANGELOG 2.8.1).
 *
 * For each fix, the same attacker runs against:
 *   1) a minimal legacy twin where the old pattern is still open (attack succeeds)
 *   2) production code where the fix blocks the attack
 *
 * Scenarios:
 *   A — depositLiquidity needs nonReentrant (nested deposit via hook token)
 *   B — claimVaultFees needs nonReentrant (cross-entry during fee payout)
 *   C — Idle must stay deferred until after fulfillRedeem (Idle-gated LP mid-settlement)
 */
import { expect } from "chai";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, networkHelpers } from "../helpers/hh";
import { deployUUPSProxy, deployOrionConfigForTests } from "../helpers/deployUpgradeable";
import { resetNetwork } from "../helpers/resetNetwork";
import { emptyVaultState } from "../helpers/loPerformPayload";
import type {
  CallbackERC20,
  IdleWindowRedeemer,
  LegacyIdleBeforeFulfillOrchestrator,
  LiquidityOrchestrator,
  LiquidityOrchestratorVaultHarness,
  NestedDepositAttacker,
  OrionTransparentVault,
  PriceAdapterRegistry,
  ReenteringFeeManager,
  TransparentVaultFactory,
  UnguardedClaimFeesVault,
  UnguardedDepositLiquidityOrchestrator,
} from "../../typechain-types";

const PHASE_IDLE = 0;
const PHASE_PVO = 4;

describe("CEI hardening regression PoCs", function () {
  before(async function () {
    await resetNetwork();
  });

  async function impersonate(address: string) {
    await networkHelpers.impersonateAccount(address);
    await networkHelpers.setBalance(address, ethers.parseEther("10"));
    return ethers.getSigner(address);
  }

  describe("A — depositLiquidity nonReentrant", function () {
    it("legacy twin: nested depositLiquidity succeeds while outer buffer is still stale", async function () {
      const [deployer] = await ethers.getSigners();

      const token = (await (
        await ethers.getContractFactory("CallbackERC20")
      ).deploy(6)) as unknown as CallbackERC20;
      await token.waitForDeployment();
      await token.setCallbackMode(1); // FromOnly — notify payer on pull

      const unguarded = (await (
        await ethers.getContractFactory("UnguardedDepositLiquidityOrchestrator")
      ).deploy(await token.getAddress())) as unknown as UnguardedDepositLiquidityOrchestrator;
      await unguarded.waitForDeployment();

      const attacker = (await (
        await ethers.getContractFactory("NestedDepositAttacker")
      ).deploy(await unguarded.getAddress())) as unknown as NestedDepositAttacker;
      await attacker.waitForDeployment();

      const outer = 100n;
      const nested = 40n;
      await attacker.setNestedAmount(nested);
      await token.mint(await attacker.getAddress(), outer + nested);
      // Approve from attacker contract via impersonation-free path: mint to deployer, transfer to attacker, attacker needs approve.
      // NestedDepositAttacker has no approve helper — approve via low-level from attacker after mint to attacker.
      await networkHelpers.impersonateAccount(await attacker.getAddress());
      await networkHelpers.setBalance(await attacker.getAddress(), ethers.parseEther("1"));
      const attackerSigner = await ethers.getSigner(await attacker.getAddress());
      await token.connect(attackerSigner).approve(await unguarded.getAddress(), outer + nested);
      await networkHelpers.stopImpersonatingAccount(await attacker.getAddress());

      await attacker.deposit(outer);

      expect(await attacker.nestedSucceeded()).to.equal(true);
      expect(await attacker.bufferSeenDuringCallback()).to.equal(0n);
      expect(await unguarded.bufferAmount()).to.equal(outer + nested);
      void deployer;
    });

    it("production: nested depositLiquidity is blocked by nonReentrant", async function () {
      const [owner, automation] = await ethers.getSigners();

      const token = (await (
        await ethers.getContractFactory("CallbackERC20")
      ).deploy(6)) as unknown as CallbackERC20;
      await token.waitForDeployment();
      await token.setCallbackMode(1); // FromOnly — notify payer on pull

      const orionConfig = await deployOrionConfigForTests(owner, await token.getAddress());
      const priceAdapterRegistry = await deployUUPSProxy<PriceAdapterRegistry>(
        "PriceAdapterRegistry",
        [await orionConfig.getAddress()],
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
      const lo = await deployUUPSProxy<LiquidityOrchestrator>(
        "LiquidityOrchestrator",
        [await orionConfig.getAddress(), automation.address, await sp1VerifierGateway.getAddress(), vKey],
        owner,
      );
      await orionConfig.setLiquidityOrchestrator(await lo.getAddress());

      const attacker = (await (
        await ethers.getContractFactory("NestedDepositAttacker")
      ).deploy(await lo.getAddress())) as unknown as NestedDepositAttacker;
      await attacker.waitForDeployment();

      const outer = 100n;
      const nested = 40n;
      await attacker.setNestedAmount(nested);
      await token.mint(await attacker.getAddress(), outer + nested);

      await networkHelpers.impersonateAccount(await attacker.getAddress());
      await networkHelpers.setBalance(await attacker.getAddress(), ethers.parseEther("1"));
      const attackerSigner = await ethers.getSigner(await attacker.getAddress());
      await token.connect(attackerSigner).approve(await lo.getAddress(), outer + nested);
      await networkHelpers.stopImpersonatingAccount(await attacker.getAddress());

      await attacker.deposit(outer);

      expect(await attacker.nestedSucceeded()).to.equal(false);
      expect(await attacker.bufferSeenDuringCallback()).to.equal(0n);
      expect(await lo.bufferAmount()).to.equal(outer);
    });
  });

  describe("B — claimVaultFees nonReentrant", function () {
    it("legacy twin: fee manager reenters sensitiveOp during payout", async function () {
      const token = (await (
        await ethers.getContractFactory("CallbackERC20")
      ).deploy(6)) as unknown as CallbackERC20;
      await token.waitForDeployment();
      // Legacy vault notifies the manager after transfer (same window as a hook token).
      await token.setCallbacksEnabled(false);

      const manager = (await (
        await ethers.getContractFactory("ReenteringFeeManager")
      ).deploy()) as unknown as ReenteringFeeManager;
      await manager.waitForDeployment();

      const vault = (await (
        await ethers.getContractFactory("UnguardedClaimFeesVault")
      ).deploy(await token.getAddress(), await manager.getAddress())) as unknown as UnguardedClaimFeesVault;
      await vault.waitForDeployment();

      await manager.setVault(await vault.getAddress());
      await manager.setUseSensitiveOpProbe(true);

      const fee = 50n;
      await vault.accrue(fee);
      await token.mint(await vault.getAddress(), fee);

      await manager.claimUnguardedFees(fee);

      expect(await manager.callbackReached()).to.equal(true);
      expect(await manager.reenteredSensitiveOp()).to.equal(true);
      expect(await vault.sensitiveOpCalled()).to.equal(true);
      expect(await vault.guardedOpCalled()).to.equal(true);
      expect(await vault.pendingFees()).to.equal(0n);
      expect(await token.balanceOf(await manager.getAddress())).to.equal(fee);
    });

    it("production: fee manager cannot requestDeposit during claimVaultFees", async function () {
      const [owner, strategist] = await ethers.getSigners();

      const token = (await (
        await ethers.getContractFactory("CallbackERC20")
      ).deploy(6)) as unknown as CallbackERC20;
      await token.waitForDeployment();
      await token.setCallbackMode(2); // ToOnly — notify fee recipient on push

      const orionConfig = await deployOrionConfigForTests(owner, await token.getAddress());
      const priceAdapterRegistry = await deployUUPSProxy<PriceAdapterRegistry>(
        "PriceAdapterRegistry",
        [await orionConfig.getAddress()],
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
      const lo = await deployUUPSProxy<LiquidityOrchestrator>(
        "LiquidityOrchestrator",
        [await orionConfig.getAddress(), owner.address, await sp1VerifierGateway.getAddress(), vKey],
        owner,
      );
      await orionConfig.setLiquidityOrchestrator(await lo.getAddress());

      const VaultImplFactory = await ethers.getContractFactory("OrionTransparentVault");
      const vaultImpl = await VaultImplFactory.deploy();
      await vaultImpl.waitForDeployment();
      const BeaconFactory = await ethers.getContractFactory("OrionUpgradeableBeacon");
      const vaultBeacon = await BeaconFactory.deploy(await vaultImpl.getAddress(), owner.address);
      await vaultBeacon.waitForDeployment();

      const factory = await deployUUPSProxy<TransparentVaultFactory>(
        "TransparentVaultFactory",
        [await orionConfig.getAddress(), await vaultBeacon.getAddress()],
        owner,
      );
      await orionConfig.setVaultFactory(await factory.getAddress());

      const manager = (await (
        await ethers.getContractFactory("ReenteringFeeManager")
      ).deploy()) as unknown as ReenteringFeeManager;
      await manager.waitForDeployment();

      await orionConfig.addWhitelistedManager(await manager.getAddress());

      // Manager contract creates the vault so it owns manager role.
      await networkHelpers.impersonateAccount(await manager.getAddress());
      await networkHelpers.setBalance(await manager.getAddress(), ethers.parseEther("1"));
      const managerSigner = await ethers.getSigner(await manager.getAddress());
      const tx = await factory
        .connect(managerSigner)
        .createVault(
          strategist.address,
          "Fee Reentrancy Vault",
          "FRV",
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
          return factory.interface.parseLog(l)?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      const vaultAddress = factory.interface.parseLog(log!)?.args?.[0] as string;
      await networkHelpers.stopImpersonatingAccount(await manager.getAddress());

      const vault = (await ethers.getContractAt(
        "OrionTransparentVault",
        vaultAddress,
      )) as unknown as OrionTransparentVault;

      await manager.setVault(vaultAddress);
      await manager.setUnderlying(await token.getAddress());

      const fee = ethers.parseUnits("25", 6);
      const loSigner = await impersonate(await lo.getAddress());
      await vault.connect(loSigner).accrueVaultFees(fee, 0n);
      await token.mint(await lo.getAddress(), fee);

      // Fund manager so a nested requestDeposit would have assets if the guard were absent.
      await token.mint(await manager.getAddress(), 1n);

      await manager.claimFees(fee);

      expect(await manager.reenteredRequestDeposit()).to.equal(false);
      expect(await vault.pendingVaultFees()).to.equal(0n);
      expect(await token.balanceOf(await manager.getAddress())).to.equal(fee + 1n);
    });
  });

  describe("C — Idle deferred until after fulfillRedeem", function () {
    async function createVaultWithManager(
      factory: TransparentVaultFactory,
      manager: SignerWithAddress,
      strategist: SignerWithAddress,
      name: string,
    ): Promise<OrionTransparentVault> {
      const tx = await factory
        .connect(manager)
        .createVault(
          strategist.address,
          name,
          name.slice(0, 3),
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
          return factory.interface.parseLog(l)?.name === "OrionVaultCreated";
        } catch {
          return false;
        }
      });
      const vaultAddress = factory.interface.parseLog(log!)?.args?.[0] as string;
      return ethers.getContractAt("OrionTransparentVault", vaultAddress) as unknown as Promise<OrionTransparentVault>;
    }

    it("legacy twin: redeemer sees Idle and can depositLiquidity mid-fulfillRedeem", async function () {
      const [owner, manager, strategist, lp] = await ethers.getSigners();

      const token = (await (
        await ethers.getContractFactory("CallbackERC20")
      ).deploy(6)) as unknown as CallbackERC20;
      await token.waitForDeployment();
      await token.setCallbackMode(2); // ToOnly — notify redeem recipient on push

      const orionConfig = await deployOrionConfigForTests(owner, await token.getAddress());

      const legacyLo = (await (
        await ethers.getContractFactory("LegacyIdleBeforeFulfillOrchestrator")
      ).deploy(await orionConfig.getAddress())) as unknown as LegacyIdleBeforeFulfillOrchestrator;
      await legacyLo.waitForDeployment();
      await orionConfig.setLiquidityOrchestrator(await legacyLo.getAddress());

      const VaultImplFactory = await ethers.getContractFactory("OrionTransparentVault");
      const vaultImpl = await VaultImplFactory.deploy();
      await vaultImpl.waitForDeployment();
      const BeaconFactory = await ethers.getContractFactory("OrionUpgradeableBeacon");
      const vaultBeacon = await BeaconFactory.deploy(await vaultImpl.getAddress(), owner.address);
      await vaultBeacon.waitForDeployment();

      const factory = await deployUUPSProxy<TransparentVaultFactory>(
        "TransparentVaultFactory",
        [await orionConfig.getAddress(), await vaultBeacon.getAddress()],
        owner,
      );
      await orionConfig.setVaultFactory(await factory.getAddress());
      await orionConfig.addWhitelistedManager(manager.address);

      const vault = await createVaultWithManager(factory, manager, strategist, "LegacyIdle");

      const redeemer = (await (
        await ethers.getContractFactory("IdleWindowRedeemer")
      ).deploy(await orionConfig.getAddress())) as unknown as IdleWindowRedeemer;
      await redeemer.waitForDeployment();
      await redeemer.configure(await vault.getAddress(), await legacyLo.getAddress(), await token.getAddress());

      const depositAmt = ethers.parseUnits("100", 6);
      await token.mint(lp.address, depositAmt);
      await token.connect(lp).approve(await vault.getAddress(), depositAmt);
      await vault.connect(lp).requestDeposit(depositAmt);

      // Seed LO with assets for later redeem payout + fulfill deposit.
      await token.mint(await legacyLo.getAddress(), depositAmt);
      await legacyLo.fulfillDeposit(vault, depositAmt);

      const shares = await vault.balanceOf(lp.address);
      expect(shares).to.be.gt(0n);
      await vault.connect(lp).transfer(await redeemer.getAddress(), shares);

      // Fund redeemer so nested depositLiquidity can pull assets if Idle is open.
      await token.mint(await redeemer.getAddress(), 1n);

      await networkHelpers.impersonateAccount(await redeemer.getAddress());
      await networkHelpers.setBalance(await redeemer.getAddress(), ethers.parseEther("1"));
      const redeemerSigner = await ethers.getSigner(await redeemer.getAddress());
      await vault.connect(redeemerSigner).approve(await vault.getAddress(), shares);
      await vault.connect(redeemerSigner).requestRedeem(shares);
      await networkHelpers.stopImpersonatingAccount(await redeemer.getAddress());

      // Ensure LO still holds underlying for the redeem push.
      const loBal = await token.balanceOf(await legacyLo.getAddress());
      if (loBal < depositAmt) {
        await token.mint(await legacyLo.getAddress(), depositAmt - loBal);
      }

      await legacyLo.processRedeemLegacy(vault, depositAmt);

      expect(await redeemer.seenIdleDuringPayout()).to.equal(true);
      expect(await redeemer.idleGatedDepositSucceeded()).to.equal(true);
      expect(await legacyLo.bufferAmount()).to.equal(1n);
    });

    it("production: redeemer sees non-Idle and cannot depositLiquidity mid-fulfillRedeem", async function () {
      const [owner, manager, strategist, lp] = await ethers.getSigners();

      const token = (await (
        await ethers.getContractFactory("CallbackERC20")
      ).deploy(6)) as unknown as CallbackERC20;
      await token.waitForDeployment();
      await token.setCallbackMode(2); // ToOnly — notify redeem recipient on push

      const orionConfig = await deployOrionConfigForTests(owner, await token.getAddress());
      const priceAdapterRegistry = await deployUUPSProxy<PriceAdapterRegistry>(
        "PriceAdapterRegistry",
        [await orionConfig.getAddress()],
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
      const harness = await deployUUPSProxy<LiquidityOrchestratorVaultHarness>(
        "LiquidityOrchestratorVaultHarness",
        [await orionConfig.getAddress(), owner.address, await sp1VerifierGateway.getAddress(), vKey],
        owner,
      );
      await orionConfig.setLiquidityOrchestrator(await harness.getAddress());

      const VaultImplFactory = await ethers.getContractFactory("OrionTransparentVault");
      const vaultImpl = await VaultImplFactory.deploy();
      await vaultImpl.waitForDeployment();
      const BeaconFactory = await ethers.getContractFactory("OrionUpgradeableBeacon");
      const vaultBeacon = await BeaconFactory.deploy(await vaultImpl.getAddress(), owner.address);
      await vaultBeacon.waitForDeployment();

      const factory = await deployUUPSProxy<TransparentVaultFactory>(
        "TransparentVaultFactory",
        [await orionConfig.getAddress(), await vaultBeacon.getAddress()],
        owner,
      );
      await orionConfig.setVaultFactory(await factory.getAddress());
      await orionConfig.addWhitelistedManager(manager.address);

      const vault = await createVaultWithManager(factory, manager, strategist, "ProdIdle");

      const redeemer = (await (
        await ethers.getContractFactory("IdleWindowRedeemer")
      ).deploy(await orionConfig.getAddress())) as unknown as IdleWindowRedeemer;
      await redeemer.waitForDeployment();
      await redeemer.configure(await vault.getAddress(), await harness.getAddress(), await token.getAddress());

      const depositAmt = ethers.parseUnits("100", 6);
      await token.mint(lp.address, depositAmt);
      await token.connect(lp).approve(await vault.getAddress(), depositAmt);
      await vault.connect(lp).requestDeposit(depositAmt);

      await token.mint(await harness.getAddress(), depositAmt);
      const loSigner = await impersonate(await harness.getAddress());
      await vault.connect(loSigner).fulfillDeposit(depositAmt);

      const shares = await vault.balanceOf(lp.address);
      expect(shares).to.be.gt(0n);
      await vault.connect(lp).transfer(await redeemer.getAddress(), shares);
      await token.mint(await redeemer.getAddress(), 1n);

      await networkHelpers.impersonateAccount(await redeemer.getAddress());
      await networkHelpers.setBalance(await redeemer.getAddress(), ethers.parseEther("1"));
      const redeemerSigner = await ethers.getSigner(await redeemer.getAddress());
      await vault.connect(redeemerSigner).approve(await vault.getAddress(), shares);
      await vault.connect(redeemerSigner).requestRedeem(shares);
      await networkHelpers.stopImpersonatingAccount(await redeemer.getAddress());

      // Stay in PVO through fulfill (production ordering); Idle is only set after the vault loop in performUpkeep.
      await harness.h_setPhase(PHASE_PVO);
      const state = emptyVaultState();
      state.processRedeem = true;
      state.totalAssetsForRedeem = depositAmt;
      state.finalTotalAssets = 0n;

      await harness.exposed_processSingleVaultOperations(await vault.getAddress(), state);

      expect(await redeemer.seenIdleDuringPayout()).to.equal(false);
      expect(await redeemer.idleGatedDepositSucceeded()).to.equal(false);
      expect(await orionConfig.isSystemIdle()).to.equal(false);
      expect(await harness.currentPhase()).to.equal(PHASE_PVO);
      expect(await harness.bufferAmount()).to.equal(0n);
      void PHASE_IDLE;
    });
  });
});
