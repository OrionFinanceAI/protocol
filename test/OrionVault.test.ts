import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";

import {
  MockUnderlyingAsset,
  MockERC4626Asset,
  MockPriceAdapter,
  MockExecutionAdapter,
  OrionConfig,
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  EncryptedVaultFactory,
  OrionEncryptedVault,
  PriceAdapterRegistry,
} from "../typechain-types";

let encryptedVaultFactory: EncryptedVaultFactory;
let orionConfig: OrionConfig;
let underlyingAsset: MockUnderlyingAsset;
let mockAsset1: MockERC4626Asset;
let mockAsset2: MockERC4626Asset;
let mockPriceAdapter1: MockPriceAdapter;
let mockPriceAdapter2: MockPriceAdapter;
let mockExecutionAdapter1: MockExecutionAdapter;
let mockExecutionAdapter2: MockExecutionAdapter;
let priceAdapterRegistry: PriceAdapterRegistry;
let internalStatesOrchestrator: InternalStatesOrchestrator;
let liquidityOrchestrator: LiquidityOrchestrator;
let vault: OrionEncryptedVault; // Using encrypted vault as the test subject

let owner: SignerWithAddress, curator: SignerWithAddress, other: SignerWithAddress, user: SignerWithAddress;

beforeEach(async function () {
  [owner, curator, other, user] = await ethers.getSigners();

  const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
  const underlyingAssetDeployed = await MockUnderlyingAssetFactory.deploy(6);
  await underlyingAssetDeployed.waitForDeployment();
  underlyingAsset = underlyingAssetDeployed as unknown as MockUnderlyingAsset;

  const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
  const mockAsset1Deployed = await MockERC4626AssetFactory.deploy(
    await underlyingAsset.getAddress(),
    "Mock Asset 1",
    "MA1",
    18,
  );
  await mockAsset1Deployed.waitForDeployment();
  mockAsset1 = mockAsset1Deployed as unknown as MockERC4626Asset;

  const mockAsset2Deployed = await MockERC4626AssetFactory.deploy(
    await underlyingAsset.getAddress(),
    "Mock Asset 2",
    "MA2",
    18,
  );
  await mockAsset2Deployed.waitForDeployment();
  mockAsset2 = mockAsset2Deployed as unknown as MockERC4626Asset;

  // Deploy OrionConfig
  const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
  const orionConfigDeployed = await OrionConfigFactory.deploy(owner.address, await underlyingAsset.getAddress());
  await orionConfigDeployed.waitForDeployment();
  orionConfig = orionConfigDeployed as unknown as OrionConfig;

  const EncryptedVaultFactoryFactory = await ethers.getContractFactory("EncryptedVaultFactory");
  const encryptedVaultFactoryDeployed = await EncryptedVaultFactoryFactory.deploy(await orionConfig.getAddress());
  await encryptedVaultFactoryDeployed.waitForDeployment();
  encryptedVaultFactory = encryptedVaultFactoryDeployed as unknown as EncryptedVaultFactory;

  const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestrator");
  const internalStatesOrchestratorDeployed = await InternalStatesOrchestratorFactory.deploy(
    owner.address,
    await orionConfig.getAddress(),
    await other.address,
  );
  await internalStatesOrchestratorDeployed.waitForDeployment();
  internalStatesOrchestrator = internalStatesOrchestratorDeployed as unknown as InternalStatesOrchestrator;

  const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
  const liquidityOrchestratorDeployed = await LiquidityOrchestratorFactory.deploy(
    owner.address,
    await orionConfig.getAddress(),
    await other.address,
  );
  await liquidityOrchestratorDeployed.waitForDeployment();
  liquidityOrchestrator = liquidityOrchestratorDeployed as unknown as LiquidityOrchestrator;

  const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
  mockPriceAdapter1 = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
  await mockPriceAdapter1.waitForDeployment();

  mockPriceAdapter2 = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
  await mockPriceAdapter2.waitForDeployment();

  const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
  mockExecutionAdapter1 = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
  await mockExecutionAdapter1.waitForDeployment();

  mockExecutionAdapter2 = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
  await mockExecutionAdapter2.waitForDeployment();

  const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
  const priceAdapterRegistryDeployed = await PriceAdapterRegistryFactory.deploy(
    owner.address,
    await orionConfig.getAddress(),
  );
  await priceAdapterRegistryDeployed.waitForDeployment();
  priceAdapterRegistry = priceAdapterRegistryDeployed as unknown as PriceAdapterRegistry;

  await orionConfig.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());
  await orionConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());
  await orionConfig.setVaultFactories(other.address, await encryptedVaultFactory.getAddress());
  await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());
  await orionConfig.setProtocolRiskFreeRate(0.0423 * 10_000);

  await orionConfig.addWhitelistedAsset(
    await mockAsset1.getAddress(),
    await mockPriceAdapter1.getAddress(),
    await mockExecutionAdapter1.getAddress(),
  );
  await orionConfig.addWhitelistedAsset(
    await mockAsset2.getAddress(),
    await mockPriceAdapter2.getAddress(),
    await mockExecutionAdapter2.getAddress(),
  );

  // Create a vault for testing
  const tx = await encryptedVaultFactory.connect(owner).createVault(curator.address, "Test Vault", "TV", 0, 0, 0);
  const receipt = await tx.wait();
  const event = receipt?.logs.find((log) => {
    try {
      const parsed = encryptedVaultFactory.interface.parseLog(log);
      return parsed?.name === "OrionVaultCreated";
    } catch {
      return false;
    }
  });
  const parsedEvent = encryptedVaultFactory.interface.parseLog(event!);
  const vaultAddress = parsedEvent?.args[0];
  vault = (await ethers.getContractAt("OrionEncryptedVault", vaultAddress)) as unknown as OrionEncryptedVault;

  // Give user some underlying assets for testing
  await underlyingAsset.mint(user.address, ethers.parseUnits("10000", 6));
  await underlyingAsset.connect(user).approve(await vault.getAddress(), ethers.parseUnits("10000", 6));
});

describe("OrionVault - Base Functionality", function () {
  describe("Synchronous ERC4626 Functions", function () {
    it("Should revert deposit function with SynchronousCallDisabled error", async function () {
      const depositAmount = ethers.parseUnits("100", 6);

      await expect(vault.previewDeposit(depositAmount)).to.be.revertedWithCustomError(vault, "SynchronousCallDisabled");
      await expect(vault.deposit(depositAmount, user.address)).to.be.revertedWithCustomError(
        vault,
        "SynchronousCallDisabled",
      );
    });

    it("Should revert mint function with SynchronousCallDisabled error", async function () {
      const mintAmount = ethers.parseUnits("100", 18);

      await expect(vault.previewMint(mintAmount)).to.be.revertedWithCustomError(vault, "SynchronousCallDisabled");
      await expect(vault.mint(mintAmount, user.address)).to.be.revertedWithCustomError(
        vault,
        "SynchronousCallDisabled",
      );
    });

    it("Should revert withdraw function with SynchronousCallDisabled error", async function () {
      const withdrawAmount = ethers.parseUnits("100", 6);

      await expect(vault.previewWithdraw(withdrawAmount)).to.be.revertedWithCustomError(
        vault,
        "SynchronousCallDisabled",
      );
      await expect(vault.withdraw(withdrawAmount, user.address, user.address)).to.be.revertedWithCustomError(
        vault,
        "SynchronousCallDisabled",
      );
    });

    it("Should revert redeem function with SynchronousCallDisabled error", async function () {
      const redeemAmount = ethers.parseUnits("100", 18);

      await expect(vault.previewRedeem(redeemAmount)).to.be.revertedWithCustomError(vault, "SynchronousCallDisabled");
      await expect(vault.redeem(redeemAmount, user.address, user.address)).to.be.revertedWithCustomError(
        vault,
        "SynchronousCallDisabled",
      );
    });
  });

  describe("Decimals Function", function () {
    it("Should return SHARE_DECIMALS (18) for vault shares", async function () {
      const decimals = await vault.decimals();
      expect(decimals).to.equal(18);
    });
  });

  describe("Deposit Request Cancellation", function () {
    it("Should allow user to cancel deposit request", async function () {
      const depositAmount = ethers.parseUnits("100", 6);

      // First, make a deposit request
      await vault.connect(user).requestDeposit(depositAmount);

      // Verify deposit request was created
      const pendingDeposits = await vault.pendingDeposit();
      expect(pendingDeposits).to.equal(depositAmount);

      // Cancel the deposit request
      await expect(vault.connect(user).cancelDepositRequest(depositAmount)).to.not.be.reverted;

      // Verify deposit request was cancelled
      const pendingDepositsAfter = await vault.pendingDeposit();
      expect(pendingDepositsAfter).to.equal(0);
    });

    it("Should revert when cancelling deposit request with zero amount", async function () {
      await expect(vault.connect(user).cancelDepositRequest(0)).to.be.revertedWithCustomError(
        vault,
        "AmountMustBeGreaterThanZero",
      );
    });

    it("Should revert when cancelling more than requested deposit amount", async function () {
      const depositAmount = ethers.parseUnits("100", 6);
      const cancelAmount = ethers.parseUnits("200", 6);

      // Make a deposit request
      await vault.connect(user).requestDeposit(depositAmount);

      // Try to cancel more than requested
      await expect(vault.connect(user).cancelDepositRequest(cancelAmount)).to.be.revertedWithCustomError(
        vault,
        "InsufficientAmount",
      );
    });

    it("Should allow partial cancellation of deposit request", async function () {
      const depositAmount = ethers.parseUnits("100", 6);
      const cancelAmount = ethers.parseUnits("30", 6);
      const remainingAmount = depositAmount - cancelAmount;

      // Make a deposit request
      await vault.connect(user).requestDeposit(depositAmount);

      // Cancel partial amount
      await expect(vault.connect(user).cancelDepositRequest(cancelAmount)).to.not.be.reverted;

      // Verify remaining amount
      const pendingDeposits = await vault.pendingDeposit();
      expect(pendingDeposits).to.equal(remainingAmount);
    });
  });

  describe("Redeem Request", function () {
    it("Should revert when requesting redemption with zero amount", async function () {
      await expect(vault.connect(user).requestRedeem(0)).to.be.revertedWithCustomError(
        vault,
        "AmountMustBeGreaterThanZero",
      );
    });

    it("Should revert when requesting more shares than user has", async function () {
      const userBalance = await vault.balanceOf(user.address);
      const redeemAmount = userBalance + ethers.parseUnits("100", 18);

      await expect(vault.connect(user).requestRedeem(redeemAmount)).to.be.revertedWithCustomError(
        vault,
        "InsufficientAmount",
      );
    });
  });

  describe("Curator Management", function () {
    it("Should allow vault owner to update curator", async function () {
      const newCurator = other.address;

      await expect(vault.connect(owner).updateCurator(newCurator)).to.not.be.reverted;

      // Verify curator was updated
      const updatedCurator = await vault.curator();
      expect(updatedCurator).to.equal(newCurator);
    });

    it("Should revert when non-owner tries to update curator", async function () {
      const newCurator = other.address;

      await expect(vault.connect(user).updateCurator(newCurator)).to.be.revertedWithCustomError(
        vault,
        "UnauthorizedAccess",
      );
    });

    it("Should revert when setting curator to zero address", async function () {
      await expect(vault.connect(owner).updateCurator(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        vault,
        "InvalidAddress",
      );
    });

    it("Should emit CuratorUpdated event when curator is updated", async function () {
      const newCurator = other.address;

      await expect(vault.connect(owner).updateCurator(newCurator))
        .to.emit(vault, "CuratorUpdated")
        .withArgs(newCurator);
    });
  });

  describe("Pending Amounts", function () {
    it("Should return zero pending deposits initially", async function () {
      const pendingDeposits = await vault.pendingDeposit();
      expect(pendingDeposits).to.equal(0);
    });

    it("Should return zero pending redemptions initially", async function () {
      const pendingRedeems = await vault.pendingRedeem();
      expect(pendingRedeems).to.equal(0);
    });

    it("Should return correct pending deposits after deposit request", async function () {
      const depositAmount = ethers.parseUnits("100", 6);

      // Make a deposit request
      await vault.connect(user).requestDeposit(depositAmount);

      // Check pending deposits
      const pendingDeposits = await vault.pendingDeposit();
      expect(pendingDeposits).to.equal(depositAmount);
    });
  });

  describe("Access Control", function () {
    it("Should only allow vault owner to call owner-only functions", async function () {
      // Test updateCurator function
      await expect(vault.connect(user).updateCurator(other.address)).to.be.revertedWithCustomError(
        vault,
        "UnauthorizedAccess",
      );

      await expect(vault.connect(curator).updateCurator(other.address)).to.be.revertedWithCustomError(
        vault,
        "UnauthorizedAccess",
      );

      // Only owner should be able to call
      await expect(vault.connect(owner).updateCurator(other.address)).to.not.be.reverted;
    });

    it("Should only allow curator to call curator-only functions", async function () {
      // This would be tested in the specific vault implementations
      // (transparent or encrypted) since submitIntent is implemented there
      expect(await vault.curator()).to.equal(curator.address);
    });
  });

  describe("System State Validation", function () {
    it("Should allow operations when system is idle", async function () {
      const depositAmount = ethers.parseUnits("100", 6);

      // Test deposit request should succeed
      await expect(vault.connect(user).requestDeposit(depositAmount)).to.not.be.reverted;

      // Test deposit cancellation should succeed
      await expect(vault.connect(user).cancelDepositRequest(depositAmount)).to.not.be.reverted;
    });
  });

  describe("Error Handling", function () {
    it("Should handle insufficient balance errors correctly", async function () {
      const userBalance = await underlyingAsset.balanceOf(user.address);
      const excessiveAmount = userBalance + ethers.parseUnits("1000", 6);

      // Test deposit request with insufficient balance
      await expect(vault.connect(user).requestDeposit(excessiveAmount)).to.be.revertedWithCustomError(
        vault,
        "InsufficientAmount",
      );
    });

    it("Should handle zero amount errors correctly", async function () {
      // Test deposit request with zero amount
      await expect(vault.connect(user).requestDeposit(0)).to.be.revertedWithCustomError(
        vault,
        "AmountMustBeGreaterThanZero",
      );

      // Test redeem request with zero amount
      await expect(vault.connect(user).requestRedeem(0)).to.be.revertedWithCustomError(
        vault,
        "AmountMustBeGreaterThanZero",
      );
    });
  });
});
