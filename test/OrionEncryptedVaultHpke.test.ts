import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "./helpers/hh";
import { deployUUPSProxy, deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";
import {
  ORION_INTENT_V1,
  bytesToHex0x,
  encodeIntentPlaintext,
  hexToBytes,
  orionDecrypt,
  orionEncrypt,
} from "./helpers/orionHpke";

import type {
  EncryptedVaultFactory,
  MockExecutionAdapter,
  MockPriceAdapter,
  MockUnderlyingAsset,
  OrionConfig,
  OrionEncryptedVault,
  UpgradeableBeacon,
} from "../typechain-types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(__dirname, "vectors/hpke-orion-v1.json"), "utf8")) as {
  recipient: { skR: string; pkR: string };
  intent: { intent_blob: string; pt: string };
};

/**
 * TS HPKE SealBase → OrionEncryptedVault.submitIntent integration (ORION_HPKE_V1).
 * Solidity stores opaque blobs; decryption is verified offchain with skR.
 */
describe("OrionEncryptedVault – HPKE intent submit", function () {
  let owner: SignerWithAddress;
  let strategist: SignerWithAddress;
  let manager: SignerWithAddress;

  let orionConfig: OrionConfig;
  let encryptedVaultFactory: EncryptedVaultFactory;
  let underlying: MockUnderlyingAsset;
  let priceAdapter: MockPriceAdapter;
  let executionAdapter: MockExecutionAdapter;

  const pkR = hexToBytes(vectors.recipient.pkR);
  const skR = hexToBytes(vectors.recipient.skR);
  const pkRBytes32 = bytesToHex0x(pkR);

  async function createEncryptedVault(name = "HPKE Vault", symbol = "HPV"): Promise<OrionEncryptedVault> {
    const tx = await encryptedVaultFactory
      .connect(manager)
      .createVault(strategist.address, name, symbol, 0, 0, 0, ethers.ZeroAddress);
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
    [owner, strategist, manager] = await ethers.getSigners();

    const deployed = await deployUpgradeableProtocol(owner);
    underlying = deployed.underlyingAsset;
    orionConfig = deployed.orionConfig;

    await orionConfig.addWhitelistedManager(manager.address);

    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    priceAdapter = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;
    await priceAdapter.waitForDeployment();
    const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
    executionAdapter = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;
    await executionAdapter.waitForDeployment();

    // Extra asset so n>=2 and maxCiphertextLength fits 304-byte §17 blobs (176 + 64n)
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
      [owner.address, await orionConfig.getAddress(), await vaultBeacon.getAddress()],
      owner,
    );
    await orionConfig.setEncryptedVaultFactory(await encryptedVaultFactory.getAddress());

    await orionConfig.connect(owner).setHpkePublicKey(pkRBytes32);
  });

  it("publishes §17.1 pkR via hpkePublicKey()", async function () {
    expect(await orionConfig.hpkePublicKey()).to.equal(pkRBytes32);
  });

  it("stores §17.4 golden intent_blob and emits ConfidentialOrderSubmitted", async function () {
    const vault = await createEncryptedVault();
    const maxLen = Number(await vault.maxCiphertextLength());
    expect(maxLen).to.be.gte(304);

    const blob = bytesToHex0x(hexToBytes(vectors.intent.intent_blob));
    expect(ethers.getBytes(blob).length).to.equal(304);

    await expect(vault.connect(strategist).submitIntent(blob))
      .to.emit(vault, "ConfidentialOrderSubmitted")
      .withArgs(strategist.address);

    expect(await vault.getIntent()).to.equal(blob);

    const opened = await orionDecrypt(skR, hexToBytes(vectors.intent.intent_blob), ORION_INTENT_V1);
    expect(bytesToHex0x(opened).slice(2)).to.equal(vectors.intent.pt);
  });

  it("accepts CSPRNG-sealed 100% underlying intent and round-trips offchain", async function () {
    const vault = await createEncryptedVault("Live Seal", "LS");
    const underlyingAddr = await underlying.getAddress();
    const pt = encodeIntentPlaintext([underlyingAddr], [1_000_000_000]); // strategistIntentDecimals = 9
    const blobBytes = await orionEncrypt(pkR, pt, ORION_INTENT_V1);
    const blob = bytesToHex0x(blobBytes);

    expect(blobBytes.length).to.equal(48 + pt.length);
    expect(blobBytes.length).to.be.lte(Number(await vault.maxCiphertextLength()));

    await expect(vault.connect(strategist).submitIntent(blob))
      .to.emit(vault, "ConfidentialOrderSubmitted")
      .withArgs(strategist.address);

    expect(await vault.getIntent()).to.equal(blob);
    const opened = await orionDecrypt(skR, ethers.getBytes(await vault.getIntent()), ORION_INTENT_V1);
    expect(opened).to.deep.equal(pt);
  });

  it("allows strategist to overwrite intent with a second seal while Idle", async function () {
    const vault = await createEncryptedVault("Overwrite", "OW");
    const first = await orionEncrypt(
      pkR,
      encodeIntentPlaintext([await underlying.getAddress()], [1_000_000_000]),
      ORION_INTENT_V1,
    );
    await vault.connect(strategist).submitIntent(bytesToHex0x(first));

    const second = await orionEncrypt(
      pkR,
      encodeIntentPlaintext([await underlying.getAddress()], [1_000_000_000]),
      ORION_INTENT_V1,
    );
    await vault.connect(strategist).submitIntent(bytesToHex0x(second));
    expect(await vault.getIntent()).to.equal(bytesToHex0x(second));
    expect(await vault.getIntent()).to.not.equal(bytesToHex0x(first));
  });
});
