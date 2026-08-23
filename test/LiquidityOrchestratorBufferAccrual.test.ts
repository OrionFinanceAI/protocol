import { expect } from "chai";
import { AbiCoder, keccak256 } from "ethers";
import { ethers } from "./helpers/hh";
import { deployUUPSProxy } from "./helpers/deployUpgradeable";
import { resetNetwork } from "./helpers/resetNetwork";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  ControllableExecutionAdapter,
  LiquidityOrchestratorBufferHarness,
  MockSP1Verifier,
  MockUnderlyingAsset,
  OrionConfig,
  PriceAdapterRegistry,
} from "../typechain-types";

/** Matches `ILiquidityOrchestrator.StatesStruct` ABI encoding used by `_verifyPerformData`. */
const STATES_STRUCT_TYPE =
  "tuple(tuple(bool processRedeem,uint256 totalAssetsForRedeem,uint256 totalAssetsForDeposit,uint256 finalTotalAssets,uint256 managementFee,uint256 performanceFee,address[] tokens,uint256[] shares,bytes portfolioCiphertext)[] vaults,tuple(address[] sellingTokens,uint256[] sellingAmounts,uint256[] sellingEstimatedUnderlyingAmounts) sellLeg,tuple(address[] buyingTokens,uint256[] buyingAmounts,uint256[] buyingEstimatedUnderlyingAmounts) buyLeg,uint256 bufferIncrease,uint256 epochProtocolFees,uint256 nettedRebalanceVolumeUnderlying)";

const PUBLIC_VALUES_TYPE = "tuple(bytes32 inputCommitment,bytes32 outputCommitment)";

const EMPTY_LEG = {
  sellingTokens: [] as string[],
  sellingAmounts: [] as bigint[],
  sellingEstimatedUnderlyingAmounts: [] as bigint[],
};

const EMPTY_BUY_LEG = {
  buyingTokens: [] as string[],
  buyingAmounts: [] as bigint[],
  buyingEstimatedUnderlyingAmounts: [] as bigint[],
};

type BuyLeg = {
  buyingTokens: string[];
  buyingAmounts: bigint[];
  buyingEstimatedUnderlyingAmounts: bigint[];
};

function encodePerformPayload(args: {
  inputCommitment: string;
  buyLeg?: BuyLeg;
  bufferIncrease?: bigint;
  epochProtocolFees?: bigint;
}): { publicValues: string; proofBytes: string; statesBytes: string } {
  const states = {
    vaults: [] as never[],
    sellLeg: EMPTY_LEG,
    buyLeg: args.buyLeg ?? EMPTY_BUY_LEG,
    bufferIncrease: args.bufferIncrease ?? 0n,
    epochProtocolFees: args.epochProtocolFees ?? 0n,
    nettedRebalanceVolumeUnderlying: 0n,
  };
  const statesBytes = AbiCoder.defaultAbiCoder().encode([STATES_STRUCT_TYPE], [states]);
  const outputCommitment = keccak256(statesBytes);
  const publicValues = AbiCoder.defaultAbiCoder().encode(
    [PUBLIC_VALUES_TYPE],
    [{ inputCommitment: args.inputCommitment, outputCommitment }],
  );
  return { publicValues, proofBytes: "0x", statesBytes };
}

/**
 * Deferred buffer / protocol-fee accrual (Buy→PVO settlement).
 *
 * Covers both direct settlement helpers and the real `performUpkeep` BuyingLeg
 * branch (automation registry + mock SP1 verifier + ABI-encoded payloads).
 * Does not re-test slippage bounds (Slippage suite) or fee-claim ACL (Callbacks).
 */
describe("LiquidityOrchestrator – deferred buffer and fee accrual", function () {
  const PHASE_BUYING = 3; // LiquidityUpkeepPhase.BuyingLeg
  const PHASE_PVO = 4; // LiquidityUpkeepPhase.ProcessVaultOperations
  const EPOCH_COMMITMENT = ethers.id("orion.epoch.commitment.unit-test");

  let owner: SignerWithAddress;
  let automationRegistry: SignerWithAddress;
  let harness: LiquidityOrchestratorBufferHarness;
  let underlying: MockUnderlyingAsset;
  let asset: MockUnderlyingAsset;
  let adapter: ControllableExecutionAdapter;

  before(async function () {
    await resetNetwork();
  });

  beforeEach(async function () {
    [owner, automationRegistry] = await ethers.getSigners();

    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    underlying = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset;
    await underlying.waitForDeployment();
    asset = (await MockUnderlyingAssetFactory.deploy(18)) as unknown as MockUnderlyingAsset;
    await asset.waitForDeployment();

    const orionConfig = await deployUUPSProxy<OrionConfig>(
      "OrionConfig",
      [owner.address, await underlying.getAddress()],
      owner,
    );

    const registry = await deployUUPSProxy<PriceAdapterRegistry>(
      "PriceAdapterRegistry",
      [owner.address, await orionConfig.getAddress()],
      owner,
    );
    await orionConfig.setPriceAdapterRegistry(await registry.getAddress());

    const MockVerifierFactory = await ethers.getContractFactory("MockSP1Verifier");
    const mockVerifier = (await MockVerifierFactory.deploy()) as unknown as MockSP1Verifier;
    await mockVerifier.waitForDeployment();

    const vKey = "0x007ccff4696ddd1d62fec2a106aa50309ba0fdee8fc2bcbc9c0b5ea68fe200f3";
    harness = await deployUUPSProxy<LiquidityOrchestratorBufferHarness>(
      "LiquidityOrchestratorBufferHarness",
      [
        owner.address,
        await orionConfig.getAddress(),
        automationRegistry.address,
        await mockVerifier.getAddress(),
        vKey,
      ],
      owner,
    );
    await orionConfig.setLiquidityOrchestrator(await harness.getAddress());

    const AdapterFactory = await ethers.getContractFactory("ControllableExecutionAdapter");
    adapter = (await AdapterFactory.deploy(await underlying.getAddress())) as unknown as ControllableExecutionAdapter;
    await adapter.waitForDeployment();
    await harness.h_setExecutionAdapter(await asset.getAddress(), await adapter.getAddress());

    await asset.mint(await harness.getAddress(), ethers.parseEther("1000"));
    await underlying.mint(await harness.getAddress(), 10_000_000n);

    await harness.h_setEpochStateCommitment(EPOCH_COMMITMENT);
  });

  describe("1. sell/buy defer dust into _epochDeltaAmount (buffer unchanged)", function () {
    it("sell: execution > estimate accrues positive delta without touching buffer", async function () {
      await harness.h_setBufferAmount(5_000n);
      await adapter.setSellReturn(1_100n);

      await expect(harness.h_executeSell(await asset.getAddress(), 1n, 1_000n))
        .to.emit(harness, "EpochSellExecuted")
        .withArgs(await harness.epochCounter(), await asset.getAddress(), 1_100n, 1n, 1_000n);

      expect(await harness.h_epochDeltaAmount()).to.equal(100n);
      expect(await harness.bufferAmount()).to.equal(5_000n);
      expect(await harness.pendingProtocolFees()).to.equal(0n);
    });

    it("buy: estimate > execution accrues positive delta without touching buffer", async function () {
      await harness.h_setBufferAmount(5_000n);
      await adapter.setBuyReturn(900n);

      await expect(harness.h_executeBuy(await asset.getAddress(), 1n, 1_000n))
        .to.emit(harness, "EpochBuyExecuted")
        .withArgs(await harness.epochCounter(), await asset.getAddress(), 900n, 1n, 1_000n);

      expect(await harness.h_epochDeltaAmount()).to.equal(100n);
      expect(await harness.bufferAmount()).to.equal(5_000n);
    });

    it("sell then buy accumulate signed dust across the epoch", async function () {
      await adapter.setSellReturn(1_050n); // +50
      await harness.h_executeSell(await asset.getAddress(), 1n, 1_000n);
      await adapter.setBuyReturn(980n); // +(1000-980)=+20
      await harness.h_executeBuy(await asset.getAddress(), 1n, 1_000n);

      expect(await harness.h_epochDeltaAmount()).to.equal(70n);
      expect(await harness.bufferAmount()).to.equal(0n);
    });
  });

  describe("2. _applyBuyLegSettlement helper edges", function () {
    it("no-ops while still in BuyingLeg", async function () {
      await harness.h_setPhase(PHASE_BUYING);
      await harness.h_setBufferAmount(1_000n);
      await harness.h_setEpochDeltaAmount(250);
      await harness.h_setPendingProtocolFees(10n);

      await harness.h_applyBuyLegSettlement(500n, 40n);

      expect(await harness.bufferAmount()).to.equal(1_000n);
      expect(await harness.h_epochDeltaAmount()).to.equal(250n);
      expect(await harness.pendingProtocolFees()).to.equal(10n);
    });

    it("at PVO: applies bufferIncrease + deferred dust + protocol fees and clears delta", async function () {
      await harness.h_setPhase(PHASE_PVO);
      await harness.h_setBufferAmount(1_000n);
      await harness.h_setEpochDeltaAmount(200);
      await harness.h_setPendingProtocolFees(5n);

      await expect(harness.h_applyBuyLegSettlement(50n, 25n)).to.emit(harness, "ProtocolFeesAccrued").withArgs(25n);

      expect(await harness.bufferAmount()).to.equal(1_250n);
      expect(await harness.h_epochDeltaAmount()).to.equal(0n);
      expect(await harness.pendingProtocolFees()).to.equal(30n);
    });

    it("at PVO: negative deferred dust reduces buffer", async function () {
      await harness.h_setPhase(PHASE_PVO);
      await harness.h_setBufferAmount(1_000n);
      await harness.h_setEpochDeltaAmount(-150);

      await harness.h_applyBuyLegSettlement(0n, 0n);

      expect(await harness.bufferAmount()).to.equal(850n);
      expect(await harness.h_epochDeltaAmount()).to.equal(0n);
    });
  });

  describe("3. performUpkeep BuyingLeg via automation registry", function () {
    it("rejects unauthorized callers on BuyingLeg payloads", async function () {
      await harness.h_setPhase(PHASE_BUYING);
      const payload = encodePerformPayload({ inputCommitment: EPOCH_COMMITMENT });
      const [, , stranger] = await ethers.getSigners();

      await expect(
        harness.connect(stranger).performUpkeep(payload.publicValues, payload.proofBytes, payload.statesBytes),
      ).to.be.revertedWithCustomError(harness, "NotAuthorized");
    });

    it("allows automation registry to drive BuyingLeg performUpkeep", async function () {
      await harness.h_setPhase(PHASE_BUYING);
      const payload = encodePerformPayload({ inputCommitment: EPOCH_COMMITMENT });

      await harness
        .connect(automationRegistry)
        .performUpkeep(payload.publicValues, payload.proofBytes, payload.statesBytes);

      expect(await harness.currentPhase()).to.equal(PHASE_PVO);
    });

    it("completing empty buy leg calls settlement and transitions to PVO", async function () {
      await harness.h_setPhase(PHASE_BUYING);
      await harness.h_setBufferAmount(1_000n);
      await harness.h_setEpochDeltaAmount(200);
      await harness.h_setPendingProtocolFees(5n);

      const payload = encodePerformPayload({
        inputCommitment: EPOCH_COMMITMENT,
        bufferIncrease: 50n,
        epochProtocolFees: 25n,
      });

      await expect(
        harness
          .connect(automationRegistry)
          .performUpkeep(payload.publicValues, payload.proofBytes, payload.statesBytes),
      )
        .to.emit(harness, "ProtocolFeesAccrued")
        .withArgs(25n);

      expect(await harness.currentPhase()).to.equal(PHASE_PVO);
      expect(await harness.bufferAmount()).to.equal(1_250n);
      expect(await harness.h_epochDeltaAmount()).to.equal(0n);
      expect(await harness.pendingProtocolFees()).to.equal(30n);
    });

    it("incomplete buy minibatch invokes settlement but leaves BuyingLeg (no apply)", async function () {
      // executionMinibatchSize defaults to 1; two zero-amount slots → first call finishes one window only
      await harness.h_setPhase(PHASE_BUYING);
      await harness.h_setBufferAmount(1_000n);
      await harness.h_setEpochDeltaAmount(250);
      await harness.h_setPendingProtocolFees(10n);

      const tokenA = await asset.getAddress();
      const tokenB = await underlying.getAddress(); // second slot; amount 0 skips work
      const payload = encodePerformPayload({
        inputCommitment: EPOCH_COMMITMENT,
        buyLeg: {
          buyingTokens: [tokenA, tokenB],
          buyingAmounts: [0n, 0n],
          buyingEstimatedUnderlyingAmounts: [0n, 0n],
        },
        bufferIncrease: 500n,
        epochProtocolFees: 40n,
      });

      await harness
        .connect(automationRegistry)
        .performUpkeep(payload.publicValues, payload.proofBytes, payload.statesBytes);

      expect(await harness.currentPhase()).to.equal(PHASE_BUYING);
      expect(await harness.bufferAmount()).to.equal(1_000n);
      expect(await harness.h_epochDeltaAmount()).to.equal(250n);
      expect(await harness.pendingProtocolFees()).to.equal(10n);
    });

    it("sell dust then performUpkeep completing buy settles buffer via call site", async function () {
      await adapter.setSellReturn(1_020n);
      await harness.h_executeSell(await asset.getAddress(), 1n, 1_000n);
      await adapter.setBuyReturn(990n);
      await harness.h_executeBuy(await asset.getAddress(), 1n, 1_000n);
      // deferred +30

      await harness.h_setBufferAmount(10_000n);
      await harness.h_setPhase(PHASE_BUYING);

      const payload = encodePerformPayload({
        inputCommitment: EPOCH_COMMITMENT,
        bufferIncrease: 100n,
        epochProtocolFees: 7n,
      });

      await harness
        .connect(automationRegistry)
        .performUpkeep(payload.publicValues, payload.proofBytes, payload.statesBytes);

      expect(await harness.currentPhase()).to.equal(PHASE_PVO);
      expect(await harness.bufferAmount()).to.equal(10_130n);
      expect(await harness.h_epochDeltaAmount()).to.equal(0n);
      expect(await harness.pendingProtocolFees()).to.equal(7n);
    });
  });
});
