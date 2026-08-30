/**
 * Edge-branch tests for OrionVault, OrionConfig, LiquidityOrchestrator,
 * adapters, strategies, and registry. Uses harness + impersonation.
 */
import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hh";
import { deployUUPSProxy, deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  LiquidityOrchestratorVaultHarness,
  MockERC4626Asset,
  MockExecutionAdapter,
  MockPriceAdapter,
  MockUnderlyingAsset,
  OrionConfig,
  OrionTransparentVault,
  PriceAdapterRegistry,
  TransparentVaultFactory,
  UpgradeableBeacon,
  MockDepositAccessControl,
} from "../typechain-types";

const PHASE_IDLE = 0;
const PHASE_PVO = 4;
const VAULT_TYPE_ENCRYPTED = 1;

describe("OrionVault / OrionConfig / LO edge branches", function () {
  let owner: SignerWithAddress;
  let manager: SignerWithAddress;
  let strategist: SignerWithAddress;
  let stranger: SignerWithAddress;
  let guardian: SignerWithAddress;
  let user: SignerWithAddress;

  let orionConfig: OrionConfig;
  let harness: LiquidityOrchestratorVaultHarness;
  let transparentVaultFactory: TransparentVaultFactory;
  let underlying: MockUnderlyingAsset;
  let priceAdapter: MockPriceAdapter;
  let executionAdapter: MockExecutionAdapter;
  let priceAdapterRegistry: PriceAdapterRegistry;

  async function createVault(name: string, symbol: string, accessControl = ethers.ZeroAddress) {
    const tx = await transparentVaultFactory
      .connect(manager)
      .createVault(strategist.address, name, symbol, 0, 0, 0, accessControl);
    const receipt = await tx.wait();
    const log = receipt!.logs.find((l) => {
      try {
        return transparentVaultFactory.interface.parseLog(l)?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const addr = transparentVaultFactory.interface.parseLog(log!)!.args[0] as string;
    return (await ethers.getContractAt("OrionTransparentVault", addr)) as unknown as OrionTransparentVault;
  }

  async function impersonate(addr: string) {
    await networkHelpers.impersonateAccount(addr);
    await networkHelpers.setBalance(addr, ethers.parseEther("10"));
    return ethers.getSigner(addr);
  }

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    this.timeout(120_000);
    [owner, manager, strategist, stranger, guardian, user] = await ethers.getSigners();

    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    underlying = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset;
    await underlying.waitForDeployment();

    orionConfig = await deployUUPSProxy<OrionConfig>(
      "OrionConfig",
      [owner.address, await underlying.getAddress()],
      owner,
    );

    priceAdapterRegistry = await deployUUPSProxy<PriceAdapterRegistry>(
      "PriceAdapterRegistry",
      [owner.address, await orionConfig.getAddress()],
      owner,
    );
    await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

    const SP1VerifierGatewayFactory = await ethers.getContractFactory("SP1VerifierGateway");
    const gateway = await SP1VerifierGatewayFactory.deploy(owner.address);
    await gateway.waitForDeployment();
    const SP1VerifierFactory = await ethers.getContractFactory("SP1Verifier");
    const verifier = await SP1VerifierFactory.deploy();
    await verifier.waitForDeployment();
    await gateway.addRoute(await verifier.getAddress());

    const vKey = "0x007ccff4696ddd1d62fec2a106aa50309ba0fdee8fc2bcbc9c0b5ea68fe200f3";
    harness = await deployUUPSProxy<LiquidityOrchestratorVaultHarness>(
      "LiquidityOrchestratorVaultHarness",
      [owner.address, await orionConfig.getAddress(), owner.address, await gateway.getAddress(), vKey],
      owner,
    );
    await orionConfig.setLiquidityOrchestrator(await harness.getAddress());

    const VaultImplFactory = await ethers.getContractFactory("OrionTransparentVault");
    const vaultImpl = await VaultImplFactory.deploy();
    await vaultImpl.waitForDeployment();
    const BeaconFactory = await ethers.getContractFactory("OrionUpgradeableBeacon");
    const vaultBeacon = (await BeaconFactory.deploy(
      await vaultImpl.getAddress(),
      owner.address,
    )) as unknown as UpgradeableBeacon;
    await vaultBeacon.waitForDeployment();

    transparentVaultFactory = await deployUUPSProxy<TransparentVaultFactory>(
      "TransparentVaultFactory",
      [owner.address, await orionConfig.getAddress(), await vaultBeacon.getAddress()],
      owner,
    );
    await orionConfig.setVaultFactory(await transparentVaultFactory.getAddress());
    await orionConfig.addWhitelistedManager(manager.address);
    await orionConfig.setGuardian(guardian.address);

    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    priceAdapter = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
    await priceAdapter.waitForDeployment();
    const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
    executionAdapter = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
    await executionAdapter.waitForDeployment();

    const MockERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");
    const extra = (await MockERC4626Factory.deploy(
      await underlying.getAddress(),
      "Extra",
      "EXT",
    )) as unknown as MockERC4626Asset;
    await extra.waitForDeployment();
    await orionConfig.addWhitelistedAsset(
      await extra.getAddress(),
      await priceAdapter.getAddress(),
      await executionAdapter.getAddress(),
    );
  });

  describe("OrionConfig remaining branches", function () {
    it("rejects zero owner/underlying on initialize", async function () {
      const Impl = await ethers.getContractFactory("OrionConfig");
      const impl = await Impl.deploy();
      await impl.waitForDeployment();
      const Proxy = await ethers.getContractFactory("OrionERC1967Proxy");
      const badOwner = Impl.interface.encodeFunctionData("initialize", [
        ethers.ZeroAddress,
        await underlying.getAddress(),
      ]);
      await expect(Proxy.deploy(await impl.getAddress(), badOwner)).to.be.revertedWithCustomError(
        orionConfig,
        "ZeroAddress",
      );
      const badUnderlying = Impl.interface.encodeFunctionData("initialize", [owner.address, ethers.ZeroAddress]);
      await expect(Proxy.deploy(await impl.getAddress(), badUnderlying)).to.be.revertedWithCustomError(
        orionConfig,
        "ZeroAddress",
      );
    });

    it("rejects SystemNotIdle on config setters when LO phase is non-idle", async function () {
      await harness.h_setPhase(PHASE_PVO);

      await expect(orionConfig.connect(owner).setVaultFactory(stranger.address)).to.be.revertedWithCustomError(
        orionConfig,
        "SystemNotIdle",
      );
      await expect(orionConfig.connect(owner).setProtocolRiskFreeRate(100)).to.be.revertedWithCustomError(
        orionConfig,
        "SystemNotIdle",
      );
      await expect(orionConfig.connect(owner).setMinDepositAmount(1)).to.be.revertedWithCustomError(
        orionConfig,
        "SystemNotIdle",
      );
      await expect(orionConfig.connect(owner).setMinRedeemAmount(1)).to.be.revertedWithCustomError(
        orionConfig,
        "SystemNotIdle",
      );
      await expect(orionConfig.connect(owner).setFeeChangeCooldownDuration(1)).to.be.revertedWithCustomError(
        orionConfig,
        "SystemNotIdle",
      );
      await expect(orionConfig.connect(owner).setMaxFulfillBatchSize(1)).to.be.revertedWithCustomError(
        orionConfig,
        "SystemNotIdle",
      );

      await harness.h_setPhase(PHASE_IDLE);
    });

    it("rejects zero guardian and covers setMinRedeemAmount zero", async function () {
      await expect(orionConfig.connect(owner).setGuardian(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        orionConfig,
        "ZeroAddress",
      );
      await expect(orionConfig.connect(guardian).setMinRedeemAmount(0)).to.be.revertedWithCustomError(
        orionConfig,
        "InvalidArguments",
      );
      await orionConfig.connect(guardian).setMinRedeemAmount(7n);
      expect(await orionConfig.minRedeemAmount()).to.equal(7n);
    });

    it("rejects removing underlying from whitelist", async function () {
      await expect(
        orionConfig.connect(owner).removeWhitelistedAsset(await underlying.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "InvalidArguments");
    });

    it("adds encrypted vault via factory impersonation and removes manager with encrypted vault", async function () {
      const vault = await createVault("Enc", "ENC");
      const vaultAddr = await vault.getAddress();
      const factorySigner = await impersonate(await transparentVaultFactory.getAddress());

      await expect(
        orionConfig.connect(factorySigner).addOrionVault(ethers.ZeroAddress, VAULT_TYPE_ENCRYPTED),
      ).to.be.revertedWithCustomError(orionConfig, "ZeroAddress");

      // Same vault can also be registered as Encrypted (separate enumerable set)
      await orionConfig.connect(factorySigner).addOrionVault(vaultAddr, VAULT_TYPE_ENCRYPTED);
      await expect(
        orionConfig.connect(factorySigner).addOrionVault(vaultAddr, VAULT_TYPE_ENCRYPTED),
      ).to.be.revertedWithCustomError(orionConfig, "AlreadyRegistered");

      await orionConfig.connect(owner).removeWhitelistedManager(manager.address);
      expect(await orionConfig.isDecommissioningVault(vaultAddr)).to.equal(true);
    });

    it("rejects removeOrionVault for unknown vault and non-authorized caller", async function () {
      await expect(orionConfig.connect(owner).removeOrionVault(stranger.address)).to.be.revertedWithCustomError(
        orionConfig,
        "InvalidAddress",
      );
      const vault = await createVault("Rmv", "RMV");
      await expect(
        orionConfig.connect(stranger).removeOrionVault(await vault.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "NotAuthorized");
    });

    it("returns decommissioned vaults after completion and rejects bogus complete", async function () {
      const vault = await createVault("Dec", "DEC");
      const vaultAddr = await vault.getAddress();
      await orionConfig.connect(manager).removeOrionVault(vaultAddr);

      await harness.exposed_processSingleVaultOperations(vaultAddr, {
        processRedeem: true,
        totalAssetsForRedeem: 0n,
        totalAssetsForDeposit: 0n,
        finalTotalAssets: 0n,
        managementFee: 0n,
        performanceFee: 0n,
        tokens: [],
        shares: [],
        portfolioCiphertext: "0x",
      });

      const all = await orionConfig.getAllDecommissionedVaults();
      expect(all).to.include(vaultAddr);

      const loSigner = await impersonate(await harness.getAddress());
      await expect(
        orionConfig.connect(loSigner).completeVaultDecommissioning(stranger.address),
      ).to.be.revertedWithCustomError(orionConfig, "InvalidAddress");
    });
  });

  describe("OrionVault remaining branches", function () {
    it("rejects onlyConfig override from stranger", async function () {
      const vault = await createVault("Cfg", "CFG");
      await expect(vault.connect(stranger).overrideIntentForDecommissioning()).to.be.revertedWithCustomError(
        vault,
        "NotAuthorized",
      );
    });

    it("covers maxDeposit/maxMint/maxRedeem/maxWithdraw idle and access-control edges", async function () {
      const AclFactory = await ethers.getContractFactory("MockDepositAccessControl");
      const acl = (await AclFactory.deploy()) as unknown as MockDepositAccessControl;
      await acl.waitForDeployment();
      await acl.setAllowed(user.address, true);

      const vault = await createVault("ACL", "ACL", await acl.getAddress());
      expect(await vault.maxDeposit(user.address)).to.equal(ethers.MaxUint256);
      expect(await vault.maxMint(user.address)).to.equal(ethers.MaxUint256);
      expect(await vault.maxDeposit(stranger.address)).to.equal(0n);
      expect(await vault.maxMint(stranger.address)).to.equal(0n);

      await harness.h_setPhase(PHASE_PVO);
      expect(await vault.maxDeposit(user.address)).to.equal(0n);
      expect(await vault.maxRedeem(user.address)).to.equal(0n);
      expect(await vault.maxWithdraw(user.address)).to.equal(0n);
      await harness.h_setPhase(PHASE_IDLE);

      await orionConfig.connect(guardian).setMinRedeemAmount(ethers.parseUnits("1", 18));
      // No shares yet → maxRedeem 0 via balance; with shares below min also 0
      expect(await vault.maxRedeem(user.address)).to.equal(0n);
    });

    it("rejects createVault when deposit access control does not ERC-165 as IOrionAccessControl", async function () {
      const NonAclFactory = await ethers.getContractFactory("MockERC165NonStrategist");
      const nonAcl = await NonAclFactory.deploy();
      await nonAcl.waitForDeployment();

      await expect(
        transparentVaultFactory
          .connect(manager)
          .createVault(strategist.address, "Bad", "BAD", 0, 0, 0, await nonAcl.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "InvalidAddress");
    });

    it("covers deposit/redeem cancel dust floors and decommissioned request reverts", async function () {
      const vault = await createVault("Dust", "DST");
      const amount = ethers.parseUnits("100", 6);
      await underlying.mint(user.address, amount * 2n);
      await underlying.connect(user).approve(await vault.getAddress(), amount * 2n);
      await orionConfig.connect(guardian).setMinDepositAmount(ethers.parseUnits("10", 6));

      await vault.connect(user).requestDeposit(amount);
      // Partial cancel leaving dust below minDeposit
      await expect(
        vault.connect(user).cancelDepositRequest(amount - ethers.parseUnits("1", 6)),
      ).to.be.revertedWithCustomError(vault, "BelowMinimumDeposit");

      // Full cancel OK
      await vault.connect(user).cancelDepositRequest(amount);

      // Fund via LO fulfill to get shares for redeem dust path
      await underlying.mint(user.address, amount);
      await underlying.connect(user).approve(await vault.getAddress(), amount);
      await vault.connect(user).requestDeposit(amount);
      const loSigner = await impersonate(await harness.getAddress());
      await vault.connect(loSigner).fulfillDeposit(amount);

      const shares = await vault.balanceOf(user.address);
      await orionConfig.connect(guardian).setMinRedeemAmount(shares / 2n);
      await vault.connect(user).approve(await vault.getAddress(), shares);
      await vault.connect(user).requestRedeem(shares);

      await expect(vault.connect(user).cancelRedeemRequest(shares - 1n)).to.be.revertedWithCustomError(
        vault,
        "BelowMinimumRedeem",
      );
      await vault.connect(user).cancelRedeemRequest(shares);

      // Decommission blocks new deposit requests immediately; redeem only after fully decommissioned
      await orionConfig.connect(manager).removeOrionVault(await vault.getAddress());
      await expect(vault.connect(user).requestDeposit(amount)).to.be.revertedWithCustomError(
        vault,
        "VaultDecommissioned",
      );

      await harness.exposed_processSingleVaultOperations(await vault.getAddress(), {
        processRedeem: true,
        totalAssetsForRedeem: 0n,
        totalAssetsForDeposit: 0n,
        finalTotalAssets: 0n,
        managementFee: 0n,
        performanceFee: 0n,
        tokens: [],
        shares: [],
        portfolioCiphertext: "0x",
      });
      await expect(vault.connect(user).requestRedeem(1n)).to.be.revertedWithCustomError(vault, "VaultDecommissioned");
    });

    it("covers pendingRedeemBatch empty and non-empty, empty fulfill early returns", async function () {
      const vault = await createVault("Batch", "BAT");
      const [users0, shares0] = await vault.pendingRedeemBatch(10);
      expect(users0.length).to.equal(0);
      expect(shares0.length).to.equal(0);

      const loSigner = await impersonate(await harness.getAddress());
      await vault.connect(loSigner).fulfillDeposit(0);
      await vault.connect(loSigner).fulfillRedeem(0);

      const amount = ethers.parseUnits("50", 6);
      await underlying.mint(user.address, amount);
      await underlying.connect(user).approve(await vault.getAddress(), amount);
      await vault.connect(user).requestDeposit(amount);
      await vault.connect(loSigner).fulfillDeposit(amount);

      const shares = await vault.balanceOf(user.address);
      await vault.connect(user).approve(await vault.getAddress(), shares);
      await vault.connect(user).requestRedeem(shares);

      const [users, redeemShares] = await vault.pendingRedeemBatch(10);
      expect(users).to.deep.equal([user.address]);
      expect(redeemShares[0]).to.equal(shares);
      expect(await vault.pendingRedeemCount()).to.equal(1n);
    });

    it("covers synchronous redeem on decommissioned vault", async function () {
      const vault = await createVault("Sync", "SYN");
      const amount = ethers.parseUnits("40", 6);
      await underlying.mint(user.address, amount);
      await underlying.connect(user).approve(await vault.getAddress(), amount);
      await vault.connect(user).requestDeposit(amount);

      const loSigner = await impersonate(await harness.getAddress());
      await vault.connect(loSigner).fulfillDeposit(amount);
      // Seed LO with underlying for withdraw path
      await underlying.mint(await harness.getAddress(), amount);

      const shares = await vault.balanceOf(user.address);
      await orionConfig.connect(manager).removeOrionVault(await vault.getAddress());
      await harness.exposed_processSingleVaultOperations(await vault.getAddress(), {
        processRedeem: true,
        totalAssetsForRedeem: 0n,
        totalAssetsForDeposit: 0n,
        finalTotalAssets: amount,
        managementFee: 0n,
        performanceFee: 0n,
        tokens: [await underlying.getAddress()],
        shares: [0n],
        portfolioCiphertext: "0x",
      });
      expect(await orionConfig.isDecommissionedVault(await vault.getAddress())).to.equal(true);

      // maxRedeem returns full balance when decommissioned
      expect(await vault.maxRedeem(user.address)).to.equal(shares);
      expect(await vault.maxWithdraw(user.address)).to.equal(await vault.convertToAssets(shares));

      await expect(vault.connect(user).redeem(0n, user.address, user.address)).to.be.revertedWithCustomError(
        vault,
        "AmountMustBeGreaterThanZero",
      );
      await expect(vault.connect(user).redeem(shares + 1n, user.address, user.address)).to.be.rejected;

      const before = await underlying.balanceOf(user.address);
      await vault.connect(user).redeem(shares, user.address, user.address);
      expect(await underlying.balanceOf(user.address)).to.be.gt(before);
    });

    it("covers createVault feeType validation via invalid fee on init", async function () {
      // FeeType max is HURDLE_HWM (4); vault init reverts InvalidArguments for feeType > 4
      await expect(
        transparentVaultFactory
          .connect(manager)
          .createVault(strategist.address, "BadFee", "BF", 5, 0, 0, ethers.ZeroAddress),
      ).to.be.rejected;
    });

    it("covers InvalidUnderlyingDecimals, decommissioning maxDeposit, minRedeem gate, and redeem-with-allowance", async function () {
      // Underlying with >18 decimals cannot initialize a vault
      const bigUnderlying = (await (
        await ethers.getContractFactory("MockUnderlyingAsset")
      ).deploy(19)) as unknown as MockUnderlyingAsset;
      const bigProto = await deployUpgradeableProtocol(owner, bigUnderlying);
      await expect(
        bigProto.transparentVaultFactory
          .connect(owner)
          .createVault(strategist.address, "Big", "BIG", 0, 0, 0, ethers.ZeroAddress),
      ).to.be.rejected;

      const vault = await createVault("Max", "MAX");
      await orionConfig.connect(manager).removeOrionVault(await vault.getAddress());
      expect(await vault.maxDeposit(user.address)).to.equal(0n); // isDecommissioning

      const vault2 = await createVault("MinR", "MR");
      const amount = ethers.parseUnits("30", 6);
      await underlying.mint(user.address, amount);
      await underlying.connect(user).approve(await vault2.getAddress(), amount);
      await vault2.connect(user).requestDeposit(amount);
      const loSigner = await impersonate(await harness.getAddress());
      await vault2.connect(loSigner).fulfillDeposit(amount);
      const shares = await vault2.balanceOf(user.address);
      await orionConfig.connect(guardian).setMinRedeemAmount(shares + 1n);
      expect(await vault2.maxRedeem(user.address)).to.equal(0n);
      await orionConfig.connect(guardian).setMinRedeemAmount(1n);
      expect(await vault2.maxRedeem(user.address)).to.equal(shares);

      // Decommission + allowance redeem path (msg.sender != owner)
      await underlying.mint(await harness.getAddress(), amount);
      await orionConfig.connect(manager).removeOrionVault(await vault2.getAddress());
      await harness.exposed_processSingleVaultOperations(await vault2.getAddress(), {
        processRedeem: true,
        totalAssetsForRedeem: 0n,
        totalAssetsForDeposit: 0n,
        finalTotalAssets: amount,
        managementFee: 0n,
        performanceFee: 0n,
        tokens: [await underlying.getAddress()],
        shares: [0n],
        portfolioCiphertext: "0x",
      });
      await vault2.connect(user).approve(stranger.address, shares);
      await vault2.connect(stranger).redeem(shares, stranger.address, user.address);
    });
  });

  describe("LiquidityOrchestrator remaining branches", function () {
    it("rejects zero-arg initialize", async function () {
      const Impl = await ethers.getContractFactory("LiquidityOrchestratorHarness");
      const impl = await Impl.deploy();
      await impl.waitForDeployment();
      const Proxy = await ethers.getContractFactory("OrionERC1967Proxy");
      const vKey = "0x007ccff4696ddd1d62fec2a106aa50309ba0fdee8fc2bcbc9c0b5ea68fe200f3";
      const gateway = await harness.verifier();

      const cases = [
        [ethers.ZeroAddress, await orionConfig.getAddress(), owner.address, gateway, vKey],
        [owner.address, ethers.ZeroAddress, owner.address, gateway, vKey],
        [owner.address, await orionConfig.getAddress(), ethers.ZeroAddress, gateway, vKey],
        [owner.address, await orionConfig.getAddress(), owner.address, ethers.ZeroAddress, vKey],
        [owner.address, await orionConfig.getAddress(), owner.address, gateway, ethers.ZeroHash],
      ];
      for (const args of cases) {
        const data = Impl.interface.encodeFunctionData("initialize", args);
        await expect(Proxy.deploy(await impl.getAddress(), data)).to.be.rejected;
      }
    });

    it("covers owner/guardian config knobs and SystemNotIdle", async function () {
      await expect(harness.connect(owner).updateEpochDuration(0)).to.be.revertedWithCustomError(
        harness,
        "InvalidArguments",
      );
      await expect(harness.connect(owner).updateExecutionMinibatchSize(0)).to.be.revertedWithCustomError(
        harness,
        "InvalidArguments",
      );
      await expect(harness.connect(owner).updateMinibatchSize(0)).to.be.revertedWithCustomError(
        harness,
        "InvalidArguments",
      );
      await expect(harness.connect(owner).setTargetBufferRatio(0)).to.be.revertedWithCustomError(
        harness,
        "InvalidArguments",
      );
      await expect(harness.connect(owner).setTargetBufferRatio(501)).to.be.revertedWithCustomError(
        harness,
        "InvalidArguments",
      );

      await harness.h_setPhase(PHASE_PVO);
      await expect(harness.connect(owner).updateEpochDuration(2)).to.be.revertedWithCustomError(
        harness,
        "SystemNotIdle",
      );
      await expect(harness.connect(owner).updateExecutionMinibatchSize(2)).to.be.revertedWithCustomError(
        harness,
        "SystemNotIdle",
      );
      await expect(harness.connect(owner).updateMinibatchSize(2)).to.be.revertedWithCustomError(
        harness,
        "SystemNotIdle",
      );
      await expect(harness.connect(owner).setTargetBufferRatio(10)).to.be.revertedWithCustomError(
        harness,
        "SystemNotIdle",
      );
      await expect(harness.connect(user).depositLiquidity(1)).to.be.revertedWithCustomError(harness, "SystemNotIdle");
      await expect(harness.connect(owner).withdrawLiquidity(1)).to.be.revertedWithCustomError(harness, "SystemNotIdle");
      await harness.h_setPhase(PHASE_IDLE);

      await harness.connect(guardian).updateEpochDuration(3600);
      await harness.connect(owner).updateExecutionMinibatchSize(2);
      await harness.connect(guardian).updateMinibatchSize(2);
      await harness.connect(owner).setTargetBufferRatio(50);
    });

    it("covers liquidity deposit/withdraw and failed-token getter", async function () {
      const amt = ethers.parseUnits("100", 6);
      await underlying.mint(owner.address, amt);
      await underlying.connect(owner).approve(await harness.getAddress(), amt);
      await harness.connect(owner).depositLiquidity(amt);
      expect(await harness.bufferAmount()).to.equal(amt);

      await expect(harness.connect(owner).withdrawLiquidity(0)).to.be.revertedWithCustomError(
        harness,
        "AmountMustBeGreaterThanZero",
      );
      await expect(harness.connect(owner).withdrawLiquidity(amt + 1n)).to.be.revertedWithCustomError(
        harness,
        "InsufficientAmount",
      );
      await harness.connect(owner).withdrawLiquidity(amt / 2n);

      expect(await harness.getFailedEpochTokens()).to.deep.equal([]);
    });

    it("covers onlyConfig setExecutionAdapter zero addresses", async function () {
      const configSigner = await impersonate(await orionConfig.getAddress());
      await expect(
        harness.connect(configSigner).setExecutionAdapter(ethers.ZeroAddress, await executionAdapter.getAddress()),
      ).to.be.revertedWithCustomError(harness, "ZeroAddress");
      await expect(
        harness.connect(configSigner).setExecutionAdapter(await underlying.getAddress(), ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(harness, "ZeroAddress");
    });

    it("covers vault fund transfer auth and decommissioned withdraw", async function () {
      await expect(harness.connect(stranger).returnDepositFunds(user.address, 1)).to.be.revertedWithCustomError(
        harness,
        "NotAuthorized",
      );
      await expect(harness.connect(stranger).transferVaultFees(1)).to.be.revertedWithCustomError(
        harness,
        "NotAuthorized",
      );
      await expect(harness.connect(stranger).transferRedemptionFunds(user.address, 1)).to.be.revertedWithCustomError(
        harness,
        "NotAuthorized",
      );
      await expect(harness.connect(stranger).withdraw(1, user.address)).to.be.revertedWithCustomError(
        harness,
        "NotAuthorized",
      );

      const vault = await createVault("Fee", "FEE");
      const vaultSigner = await impersonate(await vault.getAddress());
      await underlying.mint(await harness.getAddress(), ethers.parseUnits("10", 6));
      await expect(harness.connect(vaultSigner).transferVaultFees(0)).to.be.revertedWithCustomError(
        harness,
        "AmountMustBeGreaterThanZero",
      );
      await harness.connect(vaultSigner).transferVaultFees(ethers.parseUnits("1", 6));
      await harness.connect(vaultSigner).transferRedemptionFunds(user.address, 0); // amount==0 no-op path
      await harness.connect(vaultSigner).transferRedemptionFunds(user.address, ethers.parseUnits("1", 6));
    });

    it("covers onlySelf on execute helpers and AdapterNotSet", async function () {
      await expect(
        harness.connect(stranger)._executeSell(await underlying.getAddress(), 1, 1),
      ).to.be.revertedWithCustomError(harness, "NotAuthorized");
      await expect(
        harness.connect(stranger)._executeBuy(await underlying.getAddress(), 1, 1),
      ).to.be.revertedWithCustomError(harness, "NotAuthorized");
      await expect(harness.h_executeSell(stranger.address, 1, 1)).to.be.revertedWithCustomError(
        harness,
        "AdapterNotSet",
      );
      await expect(harness.h_executeBuy(stranger.address, 1, 1)).to.be.revertedWithCustomError(
        harness,
        "AdapterNotSet",
      );
    });

    it("covers checkUpkeep non-idle true branch", async function () {
      await harness.h_setPhase(PHASE_PVO);
      expect(await harness.checkUpkeep()).to.equal(true);
      await harness.h_setPhase(PHASE_IDLE);
    });

    it("covers onlyConfig ACL and zero depositLiquidity", async function () {
      await expect(
        harness
          .connect(stranger)
          .setExecutionAdapter(await underlying.getAddress(), await executionAdapter.getAddress()),
      ).to.be.revertedWithCustomError(harness, "NotAuthorized");

      await expect(harness.connect(owner).depositLiquidity(0)).to.be.revertedWithCustomError(
        harness,
        "AmountMustBeGreaterThanZero",
      );
    });

    it("covers processRedeem/deposit branches in single vault ops", async function () {
      const vault = await createVault("PVO", "PVO");
      const amount = ethers.parseUnits("20", 6);
      await underlying.mint(user.address, amount * 2n);
      await underlying.connect(user).approve(await vault.getAddress(), amount * 2n);
      await vault.connect(user).requestDeposit(amount);
      const loSigner = await impersonate(await harness.getAddress());
      await vault.connect(loSigner).fulfillDeposit(amount);
      const shares = await vault.balanceOf(user.address);
      await vault.connect(user).approve(await vault.getAddress(), shares);
      await vault.connect(user).requestRedeem(shares);

      await harness.exposed_processSingleVaultOperations(await vault.getAddress(), {
        processRedeem: true,
        totalAssetsForRedeem: amount,
        totalAssetsForDeposit: amount,
        finalTotalAssets: amount,
        managementFee: 1n,
        performanceFee: 1n,
        tokens: [await underlying.getAddress()],
        shares: [0n],
        portfolioCiphertext: "0x",
      });
      expect(await vault.pendingRedeemCount()).to.equal(0n);

      // Deposit-only branch (processRedeem=false, pendingDeposit>0)
      await vault.connect(user).requestDeposit(amount);
      await harness.exposed_processSingleVaultOperations(await vault.getAddress(), {
        processRedeem: false,
        totalAssetsForRedeem: 0n,
        totalAssetsForDeposit: amount,
        finalTotalAssets: amount * 2n,
        managementFee: 0n,
        performanceFee: 0n,
        tokens: [await underlying.getAddress()],
        shares: [0n],
        portfolioCiphertext: "0x",
      });
      expect(await vault.pendingDepositCount()).to.equal(0n);
    });
  });

  describe("TransparentVault SystemNotIdle + portfolio loop", function () {
    it("rejects submitIntent when system not idle and returns portfolio after LO update", async function () {
      const vault = await createVault("Idle", "IDL");
      await harness.h_setPhase(PHASE_PVO);
      await expect(
        vault.connect(strategist).submitIntent([{ token: await underlying.getAddress(), weight: 1_000_000_000 }]),
      ).to.be.revertedWithCustomError(vault, "SystemNotIdle");
      await harness.h_setPhase(PHASE_IDLE);

      const loSigner = await impersonate(await harness.getAddress());
      const token = await underlying.getAddress();
      await vault.connect(loSigner).updateVaultState([token], [123n], ethers.parseUnits("10", 6));
      const [tokens, shares] = await vault.getPortfolio();
      expect(tokens).to.deep.equal([token]);
      expect(shares).to.deep.equal([123n]);
    });
  });
});

describe("Adapters / strategies / registry edge branches", function () {
  before(async function () {
    await resetNetwork();
  });

  it("ERC4626ExecutionAdapter rejects vault/underlying without decimals metadata", async function () {
    const [owner] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockUnderlyingAsset")).deploy(6);
    const config = await (await ethers.getContractFactory("MockOrionConfig")).deploy(await usdc.getAddress());
    const lo = await (await ethers.getContractFactory("MockLiquidityOrchestrator")).deploy(await config.getAddress());
    await config.setLiquidityOrchestrator(await lo.getAddress());

    const adapter = await (
      await ethers.getContractFactory("ERC4626ExecutionAdapter")
    ).deploy(await config.getAddress());

    const brokenVault = await (
      await ethers.getContractFactory("MockERC4626NoDecimals")
    ).deploy(await usdc.getAddress(), false);
    await config.setTokenDecimals(await brokenVault.getAddress(), 18);
    await expect(adapter.validateExecutionAdapter(await brokenVault.getAddress())).to.be.revertedWithCustomError(
      adapter,
      "InvalidAdapter",
    );

    const noDecUnderlying = await (await ethers.getContractFactory("MockTokenNoDecimals")).deploy();
    const vaultBrokenUnderlying = await (
      await ethers.getContractFactory("MockERC4626BrokenUnderlyingDecimals")
    ).deploy(await noDecUnderlying.getAddress(), 18);
    await config.setTokenDecimals(await vaultBrokenUnderlying.getAddress(), 18);
    await expect(
      adapter.validateExecutionAdapter(await vaultBrokenUnderlying.getAddress()),
    ).to.be.revertedWithCustomError(adapter, "InvalidAdapter");
    void owner;
  });

  it("ChainlinkPriceAdapter rejects scaleFactor==0 when base decimals dominate", async function () {
    const adapter = await (await ethers.getContractFactory("ChainlinkPriceAdapter")).deploy();
    // 10^(0+18)/10^77 truncates to 0 without overflowing 10**exp (max safe ~77)
    const base = await (await ethers.getContractFactory("MockChainlinkFeed")).deploy(77, 1n);
    const quote = await (await ethers.getContractFactory("MockChainlinkFeed")).deploy(0, 1n);
    await expect(
      adapter.configureFeed(
        await adapter.getAddress(),
        await base.getAddress(),
        false,
        3600,
        1,
        ethers.MaxUint256,
        await quote.getAddress(),
      ),
    ).to.be.revertedWithCustomError(adapter, "InvalidArguments");
  });

  it("PriceAdapterRegistry setPriceAdapter rejects zero asset/adapter via config", async function () {
    const [owner] = await ethers.getSigners();
    const deployed = await deployUpgradeableProtocol(owner);
    const configSigner = await (async () => {
      const addr = await deployed.orionConfig.getAddress();
      await networkHelpers.impersonateAccount(addr);
      await networkHelpers.setBalance(addr, ethers.parseEther("1"));
      return ethers.getSigner(addr);
    })();
    const priceAdapter = await (await ethers.getContractFactory("MockPriceAdapter")).deploy();
    await expect(
      deployed.priceAdapterRegistry
        .connect(configSigner)
        .setPriceAdapter(ethers.ZeroAddress, await priceAdapter.getAddress()),
    ).to.be.revertedWithCustomError(deployed.priceAdapterRegistry, "ZeroAddress");
    await expect(
      deployed.priceAdapterRegistry
        .connect(configSigner)
        .setPriceAdapter(await deployed.underlyingAsset.getAddress(), ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(deployed.priceAdapterRegistry, "ZeroAddress");
  });

  it("TransparentVaultFactory initialize rejects zero config or beacon", async function () {
    const [owner] = await ethers.getSigners();
    const deployed = await deployUpgradeableProtocol(owner);
    const Impl = await ethers.getContractFactory("TransparentVaultFactory");
    const impl = await Impl.deploy();
    await impl.waitForDeployment();
    const Proxy = await ethers.getContractFactory("OrionERC1967Proxy");
    const badConfig = Impl.interface.encodeFunctionData("initialize", [
      owner.address,
      ethers.ZeroAddress,
      await deployed.vaultBeacon.getAddress(),
    ]);
    await expect(Proxy.deploy(await impl.getAddress(), badConfig)).to.be.revertedWithCustomError(
      deployed.transparentVaultFactory,
      "ZeroAddress",
    );
    const badBeacon = Impl.interface.encodeFunctionData("initialize", [
      owner.address,
      await deployed.orionConfig.getAddress(),
      ethers.ZeroAddress,
    ]);
    await expect(Proxy.deploy(await impl.getAddress(), badBeacon)).to.be.revertedWithCustomError(
      deployed.transparentVaultFactory,
      "ZeroAddress",
    );
  });
});

describe("OrionVault LO auth and fee claim edges (merged)", function () {
  before(async function () {
    await resetNetwork();
  });

  async function impersonateOrchestrator(orchestratorAddress: string) {
    await networkHelpers.impersonateAccount(orchestratorAddress);
    await networkHelpers.setBalance(orchestratorAddress, ethers.parseEther("1"));
    return ethers.getSigner(orchestratorAddress);
  }

  async function deployLoAuthFixture() {
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
      manager,
      stranger,
      vault,
      underlyingAsset: underlyingAsset as MockUnderlyingAsset,
      loAddress,
      loSigner,
    };
  }

  it("Should reject fulfillDeposit, fulfillRedeem, accrueVaultFees, updateVaultState from non-LO", async function () {
    const { vault, stranger } = await networkHelpers.loadFixture(deployLoAuthFixture);
    await expect(vault.connect(stranger).fulfillDeposit(0)).to.be.revertedWithCustomError(vault, "NotAuthorized");
    await expect(vault.connect(stranger).fulfillRedeem(0)).to.be.revertedWithCustomError(vault, "NotAuthorized");
    await expect(vault.connect(stranger).accrueVaultFees(1, 0)).to.be.revertedWithCustomError(vault, "NotAuthorized");
    await expect(vault.connect(stranger).updateVaultState([], [], 0)).to.be.revertedWithCustomError(
      vault,
      "NotAuthorized",
    );
  });

  it("Should let impersonated LO accrue vault fees and emit VaultFeesAccrued", async function () {
    const { vault, loSigner } = await networkHelpers.loadFixture(deployLoAuthFixture);
    const managementFee = ethers.parseUnits("10", 6);
    const performanceFee = ethers.parseUnits("5", 6);
    await expect(vault.connect(loSigner).accrueVaultFees(managementFee, performanceFee))
      .to.emit(vault, "VaultFeesAccrued")
      .withArgs(managementFee, performanceFee);
    expect(await vault.pendingVaultFees()).to.equal(managementFee + performanceFee);
  });

  it("Should reject non-manager claims and zero/over-pending amounts", async function () {
    const { vault, manager, stranger, loSigner } = await networkHelpers.loadFixture(deployLoAuthFixture);
    await vault.connect(loSigner).accrueVaultFees(ethers.parseUnits("10", 6), 0);
    await expect(vault.connect(stranger).claimVaultFees(1)).to.be.revertedWithCustomError(vault, "NotAuthorized");
    await expect(vault.connect(manager).claimVaultFees(0)).to.be.revertedWithCustomError(
      vault,
      "AmountMustBeGreaterThanZero",
    );
    await expect(vault.connect(manager).claimVaultFees(ethers.parseUnits("11", 6))).to.be.revertedWithCustomError(
      vault,
      "InsufficientAmount",
    );
  });

  it("Should let manager claim accrued fees from LO and clear pending", async function () {
    const { vault, manager, loSigner, loAddress, underlyingAsset } =
      await networkHelpers.loadFixture(deployLoAuthFixture);
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

  it("should reject invalid fee type above HURDLE_HWM on updateFeeModel", async function () {
    const { vault, manager } = await networkHelpers.loadFixture(deployLoAuthFixture);
    await expect(vault.connect(manager).updateFeeModel(5, 0, 0)).to.be.revertedWithCustomError(
      vault,
      "InvalidArguments",
    );
  });
});

describe("OrionConfig bootstrap and guardian ACL (merged)", function () {
  before(async function () {
    await resetNetwork();
  });

  async function deployFreshConfig() {
    const [owner, guardian, stranger] = await ethers.getSigners();
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    const underlyingAsset = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset;
    await underlyingAsset.waitForDeployment();
    const orionConfig = await deployUUPSProxy<OrionConfig>(
      "OrionConfig",
      [owner.address, await underlyingAsset.getAddress()],
      owner,
    );
    return { owner, guardian, stranger, orionConfig, underlyingAsset };
  }

  async function deployConfigWithLo() {
    const fixture = await deployFreshConfig();
    const { orionConfig, owner } = fixture;
    const priceAdapterRegistry = await deployUUPSProxy<PriceAdapterRegistry>(
      "PriceAdapterRegistry",
      [owner.address, await orionConfig.getAddress()],
      owner,
    );
    await orionConfig.connect(owner).setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());
    const SP1VerifierGatewayFactory = await ethers.getContractFactory("SP1VerifierGateway");
    const gateway = await SP1VerifierGatewayFactory.deploy(owner.address);
    await gateway.waitForDeployment();
    const SP1VerifierFactory = await ethers.getContractFactory("SP1Verifier");
    const verifier = await SP1VerifierFactory.deploy();
    await verifier.waitForDeployment();
    await gateway.addRoute(await verifier.getAddress());
    const vKey = "0x007ccff4696ddd1d62fec2a106aa50309ba0fdee8fc2bcbc9c0b5ea68fe200f3";
    const lo = await deployUUPSProxy(
      "LiquidityOrchestrator",
      [owner.address, await orionConfig.getAddress(), owner.address, await gateway.getAddress(), vKey],
      owner,
    );
    await orionConfig.connect(owner).setLiquidityOrchestrator(await lo.getAddress());
    return { ...fixture, lo, priceAdapterRegistry };
  }

  it("Should reject zero address and non-owner for bootstrap setters", async function () {
    const { orionConfig, owner, stranger } = await networkHelpers.loadFixture(deployFreshConfig);
    await expect(orionConfig.connect(owner).setLiquidityOrchestrator(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      orionConfig,
      "ZeroAddress",
    );
    await expect(orionConfig.connect(owner).setPriceAdapterRegistry(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      orionConfig,
      "ZeroAddress",
    );
    await expect(
      orionConfig.connect(stranger).setLiquidityOrchestrator(stranger.address),
    ).to.be.revertedWithCustomError(orionConfig, "OwnableUnauthorizedAccount");
    await expect(orionConfig.connect(stranger).setPriceAdapterRegistry(stranger.address)).to.be.revertedWithCustomError(
      orionConfig,
      "OwnableUnauthorizedAccount",
    );
    await expect(orionConfig.connect(stranger).setVaultFactory(stranger.address)).to.be.revertedWithCustomError(
      orionConfig,
      "OwnableUnauthorizedAccount",
    );
  });

  it("Should reject zero vault factory after LO is wired and AlreadyRegistered on second set", async function () {
    const { orionConfig, owner, lo, priceAdapterRegistry } = await networkHelpers.loadFixture(deployConfigWithLo);
    await expect(orionConfig.connect(owner).setVaultFactory(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      orionConfig,
      "ZeroAddress",
    );
    await expect(
      orionConfig.connect(owner).setPriceAdapterRegistry(await priceAdapterRegistry.getAddress()),
    ).to.be.revertedWithCustomError(orionConfig, "AlreadyRegistered");
    await expect(
      orionConfig.connect(owner).setLiquidityOrchestrator(await lo.getAddress()),
    ).to.be.revertedWithCustomError(orionConfig, "AlreadyRegistered");
    const VaultImplFactory = await ethers.getContractFactory("OrionTransparentVault");
    const vaultImpl = await VaultImplFactory.deploy();
    await vaultImpl.waitForDeployment();
    const BeaconFactory = await ethers.getContractFactory("OrionUpgradeableBeacon");
    const vaultBeacon = await BeaconFactory.deploy(await vaultImpl.getAddress(), owner.address);
    await vaultBeacon.waitForDeployment();
    const factory = await deployUUPSProxy(
      "TransparentVaultFactory",
      [owner.address, await orionConfig.getAddress(), await vaultBeacon.getAddress()],
      owner,
    );
    await orionConfig.connect(owner).setVaultFactory(await factory.getAddress());
    await expect(orionConfig.connect(owner).setVaultFactory(await factory.getAddress())).to.be.revertedWithCustomError(
      orionConfig,
      "AlreadyRegistered",
    );
  });

  it("Should allow guardian and owner, reject stranger and zero values", async function () {
    const { orionConfig, owner, guardian, stranger } = await networkHelpers.loadFixture(deployConfigWithLo);
    await orionConfig.connect(owner).setGuardian(guardian.address);
    await expect(orionConfig.connect(stranger).setMinDepositAmount(1)).to.be.revertedWithCustomError(
      orionConfig,
      "NotAuthorized",
    );
    await expect(orionConfig.connect(stranger).setMaxFulfillBatchSize(1)).to.be.revertedWithCustomError(
      orionConfig,
      "NotAuthorized",
    );
    await expect(orionConfig.connect(guardian).setMinDepositAmount(0)).to.be.revertedWithCustomError(
      orionConfig,
      "InvalidArguments",
    );
    await expect(orionConfig.connect(guardian).setMaxFulfillBatchSize(0)).to.be.revertedWithCustomError(
      orionConfig,
      "InvalidArguments",
    );
    await orionConfig.connect(guardian).setMinDepositAmount(100n);
    expect(await orionConfig.minDepositAmount()).to.equal(100n);
    await orionConfig.connect(owner).setMaxFulfillBatchSize(50n);
    expect(await orionConfig.maxFulfillBatchSize()).to.equal(50n);
  });
});
