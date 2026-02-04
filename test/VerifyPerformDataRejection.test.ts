/**
 * @title VerifyPerformData Rejection Tests
 * @notice Unit tests that load fixture RedeemBeforeDepositOrder1.json, decode using
 *         ILiquidityOrchestrator struct layout, tamper, re-encode, and assert _verifyPerformData reverts.
 * @dev Does not use orchestratorHelpers; fixtures are loaded and modified inline to test rejection paths.
 */
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import { deployUpgradeableProtocol } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";

import {
  MockUnderlyingAsset,
  MockERC4626Asset,
  MockPriceAdapter,
  MockExecutionAdapter,
  OrionConfig,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  OrionTransparentVault,
} from "../typechain-types";

const FIXTURE_NAME = "RedeemBeforeDepositOrder1";

interface Groth16Fixture {
  vkey: string;
  publicValues: string;
  proofBytes: string;
  statesBytes: string;
}

function loadFixture(name: string): Groth16Fixture {
  const fixturePath = join(__dirname, `fixtures/${name}.json`);
  return JSON.parse(readFileSync(fixturePath, "utf-8")) as Groth16Fixture;
}

/** Decode PublicValuesStruct: (bytes32 inputCommitment, bytes32 outputCommitment) */
function decodePublicValues(hex: string): { inputCommitment: string; outputCommitment: string } {
  const data = hex.startsWith("0x") ? hex.slice(2) : hex;
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["bytes32", "bytes32"], "0x" + data) as unknown as [
    string,
    string,
  ];
  return { inputCommitment: decoded[0], outputCommitment: decoded[1] };
}

/** Encode PublicValuesStruct */
function encodePublicValues(inputCommitment: string, outputCommitment: string): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32"], [inputCommitment, outputCommitment]);
}

/** Flip one byte in hex string at byte index (0-based) */
function flipByte(hex: string, byteIndex: number): string {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = Buffer.from(stripped, "hex");
  if (byteIndex >= bytes.length) return hex;
  bytes[byteIndex] ^= 0xff;
  return "0x" + Buffer.from(bytes).toString("hex");
}

describe("VerifyPerformData Rejection", function () {
  let underlyingAsset: MockUnderlyingAsset;
  let mockAsset: MockERC4626Asset;
  let mockPriceAdapter: MockPriceAdapter;
  let mockExecutionAdapter: MockExecutionAdapter;
  let orionConfig: OrionConfig;
  let liquidityOrchestrator: LiquidityOrchestrator;
  let transparentVaultFactory: TransparentVaultFactory;
  let vault: OrionTransparentVault;

  let owner: SignerWithAddress;
  let strategist: SignerWithAddress;
  let initialDepositor: SignerWithAddress;
  let automationRegistry: SignerWithAddress;

  const UNDERLYING_DECIMALS = 6;
  const INITIAL_ASSETS = ethers.parseUnits("100", UNDERLYING_DECIMALS);

  let epochDuration: bigint;
  let setupSnapshotId: string;
  let validFixture: Groth16Fixture;

  /** Advance to SellingLeg phase so next performUpkeep will call _verifyPerformData. */
  async function advanceToSellingLeg() {
    await time.increase(Number(epochDuration) + 1);
    await liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x", "0x", "0x");
    expect(await liquidityOrchestrator.currentPhase()).to.equal(1n);
    await liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x", "0x", "0x");
    expect(await liquidityOrchestrator.currentPhase()).to.equal(2n); // SellingLeg
  }

  before(async function () {
    await resetNetwork();

    [owner, strategist, initialDepositor, , , automationRegistry] = await ethers.getSigners();

    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    underlyingAsset = (await MockUnderlyingAssetFactory.deploy(UNDERLYING_DECIMALS)) as unknown as MockUnderlyingAsset;

    const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
    mockAsset = (await MockERC4626AssetFactory.deploy(
      await underlyingAsset.getAddress(),
      "Mock Vault",
      "MV",
    )) as unknown as MockERC4626Asset;

    const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
    mockPriceAdapter = (await MockPriceAdapterFactory.deploy()) as unknown as MockPriceAdapter;

    const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
    mockExecutionAdapter = (await MockExecutionAdapterFactory.deploy()) as unknown as MockExecutionAdapter;

    const deployed = await deployUpgradeableProtocol(owner, underlyingAsset, automationRegistry);
    orionConfig = deployed.orionConfig;
    liquidityOrchestrator = deployed.liquidityOrchestrator;
    transparentVaultFactory = deployed.transparentVaultFactory;

    await orionConfig.setProtocolRiskFreeRate(0);
    await liquidityOrchestrator.connect(owner).setTargetBufferRatio(100);
    await liquidityOrchestrator.connect(owner).setSlippageTolerance(50);
    await liquidityOrchestrator.connect(owner).updateMinibatchSize(8);

    await orionConfig.addWhitelistedAsset(
      await mockAsset.getAddress(),
      await mockPriceAdapter.getAddress(),
      await mockExecutionAdapter.getAddress(),
    );

    const tx = await transparentVaultFactory.createVault(
      strategist.address,
      "Test Vault",
      "TV",
      0,
      0,
      0,
      ethers.ZeroAddress,
    );
    const receipt = await tx.wait();
    const event = receipt?.logs.find((log) => {
      try {
        const parsed = transparentVaultFactory.interface.parseLog(log);
        return parsed?.name === "OrionVaultCreated";
      } catch {
        return false;
      }
    });
    const parsedEvent = transparentVaultFactory.interface.parseLog(event!);
    const vaultAddress = parsedEvent?.args[0];
    vault = (await ethers.getContractAt("OrionTransparentVault", vaultAddress)) as unknown as OrionTransparentVault;

    await vault.connect(strategist).submitIntent([{ token: await underlyingAsset.getAddress(), weight: 1000000000 }]);

    epochDuration = await liquidityOrchestrator.epochDuration();

    await underlyingAsset.mint(initialDepositor.address, INITIAL_ASSETS);
    await underlyingAsset.connect(initialDepositor).approve(await vault.getAddress(), INITIAL_ASSETS);
    await vault.connect(initialDepositor).requestDeposit(INITIAL_ASSETS);

    validFixture = loadFixture(FIXTURE_NAME);
    await advanceToSellingLeg();

    setupSnapshotId = (await network.provider.send("evm_snapshot", [])) as string;
  });

  beforeEach(async function () {
    await network.provider.send("evm_revert", [setupSnapshotId]);
    setupSnapshotId = (await network.provider.send("evm_snapshot", [])) as string;
  });

  it("Should accept valid proof/public values/states", async function () {
    await expect(
      liquidityOrchestrator
        .connect(automationRegistry)
        .performUpkeep(validFixture.publicValues, validFixture.proofBytes, validFixture.statesBytes),
    ).to.not.be.reverted;
  });

  it("Should reject a proof when inputCommitment does not match onchain commitment", async function () {
    const { inputCommitment: _ignored, outputCommitment } = decodePublicValues(validFixture.publicValues);
    const wrongInputCommitment = ethers.ZeroHash;
    const tamperedPublicValues = encodePublicValues(wrongInputCommitment, outputCommitment);

    await expect(
      liquidityOrchestrator
        .connect(automationRegistry)
        .performUpkeep(tamperedPublicValues, validFixture.proofBytes, validFixture.statesBytes),
    ).to.be.revertedWithCustomError(liquidityOrchestrator, "CommitmentMismatch");
  });

  it("Should reject a proof with modified public values", async function () {
    const tamperedPublicValues = flipByte(validFixture.publicValues, 32);

    await expect(
      liquidityOrchestrator
        .connect(automationRegistry)
        .performUpkeep(tamperedPublicValues, validFixture.proofBytes, validFixture.statesBytes),
    ).to.be.reverted;
  });

  it("Should reject a proof with modified proof bytes", async function () {
    const tamperedProofBytes = flipByte(validFixture.proofBytes, 100);

    await expect(
      liquidityOrchestrator
        .connect(automationRegistry)
        .performUpkeep(validFixture.publicValues, tamperedProofBytes, validFixture.statesBytes),
    ).to.be.reverted;
  });

  it("Should reject malicious statesBytes even with valid proof", async function () {
    const tamperedStatesBytes = flipByte(validFixture.statesBytes, 64);

    await expect(
      liquidityOrchestrator
        .connect(automationRegistry)
        .performUpkeep(validFixture.publicValues, validFixture.proofBytes, tamperedStatesBytes),
    ).to.be.reverted;
  });

  it("Should reject proof with wrong vkey (malicious program)", async function () {
    const zeroProofBytes = "0x" + "00".repeat(260);

    await expect(
      liquidityOrchestrator
        .connect(automationRegistry)
        .performUpkeep(validFixture.publicValues, zeroProofBytes, validFixture.statesBytes),
    ).to.be.reverted;
  });
});
