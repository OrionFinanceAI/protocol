import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers, networkHelpers } from "./helpers/hh";
import { deployUUPSProxy, deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";

import type {
  EncryptedVaultFactory,
  LiquidityOrchestrator,
  MockExecutionAdapter,
  MockPriceAdapter,
  MockUnderlyingAsset,
  OrionConfig,
  OrionEncryptedVault,
  UpgradeableBeacon,
} from "../typechain-types";

const VAULT_TYPE_ENCRYPTED = 1n;

/** Minimal valid OrionCiphertext length (enc 32 + tag 16). */
function ciphertextOfLength(len: number): string {
  return ethers.hexlify(ethers.randomBytes(len));
}

describe("OrionEncryptedVault", function () {
  let owner: SignerWithAddress;
  let strategist: SignerWithAddress;
  let stranger: SignerWithAddress;
  let manager: SignerWithAddress;

  let orionConfig: OrionConfig;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let encryptedVaultFactory: EncryptedVaultFactory;
  let underlying: MockUnderlyingAsset;
  let priceAdapter: MockPriceAdapter;
  let executionAdapter: MockExecutionAdapter;

  async function createEncryptedVault(name = "Enc Vault", symbol = "EV"): Promise<OrionEncryptedVault> {
    const tx = await encryptedVaultFactory
      .connect(manager)
      .createVault(
        strategist.address,
        name,
        symbol,
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
        return encryptedVaultFactory.interface.parseLog(l)?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const vaultAddress = encryptedVaultFactory.interface.parseLog(log!)?.args?.[0] as string;
    return ethers.getContractAt("OrionEncryptedVault", vaultAddress) as unknown as Promise<OrionEncryptedVault>;
  }

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    this.timeout(90_000);
    [owner, strategist, stranger, manager] = await ethers.getSigners();

    const deployed = await deployUpgradeableProtocol(owner);
    underlying = deployed.underlyingAsset;
    orionConfig = deployed.orionConfig;
    liquidityOrchestrator = deployed.liquidityOrchestrator;

    await orionConfig.addWhitelistedManager(manager.address);

    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    priceAdapter = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
    await priceAdapter.waitForDeployment();
    const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
    executionAdapter = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
    await executionAdapter.waitForDeployment();

    // Underlying is already whitelisted at config init; add one extra asset for universe size > 1
    const MockERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");
    const extra = await MockERC4626Factory.deploy(await underlying.getAddress(), "Extra", "EX");
    await extra.waitForDeployment();
    await priceAdapter.setMockPrice(await extra.getAddress(), 1e14);
    await orionConfig.addWhitelistedAsset(
      await extra.getAddress(),
      await priceAdapter.getAddress(),
      await executionAdapter.getAddress(),
    );

    const VaultImplFactory = await ethers.getContractFactory("OrionEncryptedVault");
    const vaultImpl = await VaultImplFactory.deploy();
    await vaultImpl.waitForDeployment();

    const BeaconFactory = await ethers.getContractFactory("OrionUpgradeableBeacon");
    const vaultBeacon = (await BeaconFactory.deploy(
      await vaultImpl.getAddress(),
      owner.address,
    )) as unknown as UpgradeableBeacon;
    await vaultBeacon.waitForDeployment();

    encryptedVaultFactory = await deployUUPSProxy<EncryptedVaultFactory>(
      "EncryptedVaultFactory",
      [await orionConfig.getAddress(), await vaultBeacon.getAddress()],
      owner,
    );
    await orionConfig.setEncryptedVaultFactory(await encryptedVaultFactory.getAddress());
  });

  describe("factory registration", function () {
    it("creates an encrypted vault registered only in the Encrypted set", async function () {
      const vault = await createEncryptedVault();
      const vaultAddr = await vault.getAddress();

      const encrypted = await orionConfig.getAllOrionVaults(VAULT_TYPE_ENCRYPTED);
      expect(encrypted).to.deep.equal([vaultAddr]);

      const transparent = await orionConfig.getAllOrionVaults(0);
      expect(transparent).to.not.include(vaultAddr);

      await expect(vault.getPortfolio()).to.eventually.equal("0x");
      await expect(vault.getIntent()).to.eventually.equal("0x");
    });

    it("rejects setEncryptedVaultFactory from non-owner and second registration", async function () {
      await expect(
        orionConfig.connect(stranger).setEncryptedVaultFactory(stranger.address),
      ).to.be.revertedWithCustomError(orionConfig, "OwnableUnauthorizedAccount");

      await expect(
        orionConfig.connect(owner).setEncryptedVaultFactory(await encryptedVaultFactory.getAddress()),
      ).to.be.revertedWithCustomError(orionConfig, "AlreadyRegistered");
    });

    it("rejects addOrionVault from a non-factory caller", async function () {
      await expect(
        orionConfig.connect(owner).addOrionVault(stranger.address, VAULT_TYPE_ENCRYPTED),
      ).to.be.revertedWithCustomError(orionConfig, "NotAuthorized");
    });
  });

  describe("submitIntent", function () {
    it("stores ciphertext for the strategist and emits ConfidentialOrderSubmitted", async function () {
      const vault = await createEncryptedVault();
      const blob = ciphertextOfLength(48);

      await expect(vault.connect(strategist).submitIntent(blob))
        .to.emit(vault, "ConfidentialOrderSubmitted")
        .withArgs(strategist.address);

      expect(await vault.getIntent()).to.equal(blob);
    });

    it("rejects stranger, empty, too-short, and too-long blobs", async function () {
      const vault = await createEncryptedVault();
      const n = Number(await orionConfig.whitelistedAssetsLength());
      const maxLen = 176 + 64 * n;

      await expect(vault.connect(stranger).submitIntent(ciphertextOfLength(48))).to.be.revertedWithCustomError(
        vault,
        "NotAuthorized",
      );
      await expect(vault.connect(strategist).submitIntent("0x")).to.be.revertedWithCustomError(
        vault,
        "InvalidArguments",
      );
      await expect(vault.connect(strategist).submitIntent(ciphertextOfLength(47))).to.be.revertedWithCustomError(
        vault,
        "InvalidArguments",
      );
      await expect(
        vault.connect(strategist).submitIntent(ciphertextOfLength(maxLen + 1)),
      ).to.be.revertedWithCustomError(vault, "InvalidArguments");
    });

    it("rejects submitIntent when system is not idle", async function () {
      const vault = await createEncryptedVault();
      const epochDuration = await liquidityOrchestrator.epochDuration();
      await networkHelpers.time.increase(Number(epochDuration) + 1);

      // Create a transparent vault so Idle → EpochSetup leaves Idle (owner is already a whitelisted manager)
      const tvFactory = await ethers.getContractAt(
        "TransparentVaultFactory",
        await orionConfig.transparentVaultFactory(),
      );
      await tvFactory
        .connect(owner)
        .createVault(
          strategist.address,
          "TV Idle",
          "TVI",
          0,
          0,
          0,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
        );

      await liquidityOrchestrator.connect(owner).performUpkeep("0x", "0x", "0x");
      expect(await orionConfig.isSystemIdle()).to.equal(false);

      await expect(vault.connect(strategist).submitIntent(ciphertextOfLength(48))).to.be.revertedWithCustomError(
        vault,
        "SystemNotIdle",
      );
    });
  });

  describe("maxCiphertextLength", function () {
    it("tracks whitelist size: 176 + 64 * n", async function () {
      const vault = await createEncryptedVault();
      const n = Number(await orionConfig.whitelistedAssetsLength());
      expect(await vault.maxCiphertextLength()).to.equal(BigInt(176 + 64 * n));

      const MockERC4626Factory = await ethers.getContractFactory("MockERC4626Asset");
      const more = await MockERC4626Factory.deploy(await underlying.getAddress(), "More", "MR");
      await more.waitForDeployment();
      await priceAdapter.setMockPrice(await more.getAddress(), 1e14);
      await orionConfig.addWhitelistedAsset(
        await more.getAddress(),
        await priceAdapter.getAddress(),
        await executionAdapter.getAddress(),
      );

      const n2 = Number(await orionConfig.whitelistedAssetsLength());
      expect(n2).to.equal(n + 1);
      expect(await vault.maxCiphertextLength()).to.equal(BigInt(176 + 64 * n2));
    });
  });

  describe("updateVaultState", function () {
    it("allows LO to update portfolio ciphertext and total assets", async function () {
      const vault = await createEncryptedVault();
      const blob = ciphertextOfLength(64);
      const loAddr = await liquidityOrchestrator.getAddress();

      await networkHelpers.impersonateAccount(loAddr);
      await networkHelpers.setBalance(loAddr, ethers.parseEther("1"));
      const loSigner = await ethers.getSigner(loAddr);

      await expect(vault.connect(loSigner).updateVaultState(blob, 1_000_000n)).to.emit(
        vault,
        "ConfidentialVaultStateUpdated",
      );

      expect(await vault.getPortfolio()).to.equal(blob);
      expect(await vault.totalAssets()).to.equal(1_000_000n);

      // Empty portfolio allowed
      await vault.connect(loSigner).updateVaultState("0x", 0n);
      expect(await vault.getPortfolio()).to.equal("0x");

      await networkHelpers.stopImpersonatingAccount(loAddr);
    });

    it("rejects unauthorized updateVaultState", async function () {
      const vault = await createEncryptedVault();
      await expect(vault.connect(stranger).updateVaultState(ciphertextOfLength(48), 1n)).to.be.revertedWithCustomError(
        vault,
        "NotAuthorized",
      );
      await expect(
        vault.connect(strategist).updateVaultState(ciphertextOfLength(48), 1n),
      ).to.be.revertedWithCustomError(vault, "NotAuthorized");
    });
  });
});
