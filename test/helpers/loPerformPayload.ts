import { AbiCoder, keccak256 } from "ethers";

/** Matches `ILiquidityOrchestrator.StatesStruct` ABI encoding used by `_verifyPerformData`. */
export const STATES_STRUCT_TYPE =
  "tuple(tuple(bool processRedeem,uint256 totalAssetsForRedeem,uint256 totalAssetsForDeposit,uint256 finalTotalAssets,uint256 managementFee,uint256 performanceFee,address[] tokens,uint256[] shares,bytes portfolioCiphertext)[] vaults,tuple(address[] sellingTokens,uint256[] sellingAmounts,uint256[] sellingEstimatedUnderlyingAmounts) sellLeg,tuple(address[] buyingTokens,uint256[] buyingAmounts,uint256[] buyingEstimatedUnderlyingAmounts) buyLeg,uint256 bufferIncrease,uint256 epochProtocolFees,uint256 nettedRebalanceVolumeUnderlying)";

export const PUBLIC_VALUES_TYPE = "tuple(bytes32 inputCommitment,bytes32 outputCommitment)";

export type VaultStatePayload = {
  processRedeem: boolean;
  totalAssetsForRedeem: bigint;
  totalAssetsForDeposit: bigint;
  finalTotalAssets: bigint;
  managementFee: bigint;
  performanceFee: bigint;
  tokens: string[];
  shares: bigint[];
  /** Encrypted next portfolio blob; transparent vaults use `0x`. */
  portfolioCiphertext: string;
};

export type BuyLegPayload = {
  buyingTokens: string[];
  buyingAmounts: bigint[];
  buyingEstimatedUnderlyingAmounts: bigint[];
};

export type SellLegPayload = {
  sellingTokens: string[];
  sellingAmounts: bigint[];
  sellingEstimatedUnderlyingAmounts: bigint[];
};

const EMPTY_SELL: SellLegPayload = {
  sellingTokens: [],
  sellingAmounts: [],
  sellingEstimatedUnderlyingAmounts: [],
};

const EMPTY_BUY: BuyLegPayload = {
  buyingTokens: [],
  buyingAmounts: [],
  buyingEstimatedUnderlyingAmounts: [],
};

export function emptyVaultState(): VaultStatePayload {
  return {
    processRedeem: false,
    totalAssetsForRedeem: 0n,
    totalAssetsForDeposit: 0n,
    finalTotalAssets: 0n,
    managementFee: 0n,
    performanceFee: 0n,
    tokens: [],
    shares: [],
    portfolioCiphertext: "0x",
  };
}

export function encodePerformPayload(args: {
  inputCommitment: string;
  vaults?: VaultStatePayload[];
  sellLeg?: SellLegPayload;
  buyLeg?: BuyLegPayload;
  bufferIncrease?: bigint;
  epochProtocolFees?: bigint;
  nettedRebalanceVolumeUnderlying?: bigint;
}): { publicValues: string; proofBytes: string; statesBytes: string } {
  const states = {
    vaults: args.vaults ?? [],
    sellLeg: args.sellLeg ?? EMPTY_SELL,
    buyLeg: args.buyLeg ?? EMPTY_BUY,
    bufferIncrease: args.bufferIncrease ?? 0n,
    epochProtocolFees: args.epochProtocolFees ?? 0n,
    nettedRebalanceVolumeUnderlying: args.nettedRebalanceVolumeUnderlying ?? 0n,
  };
  const statesBytes = AbiCoder.defaultAbiCoder().encode([STATES_STRUCT_TYPE], [states]);
  const outputCommitment = keccak256(statesBytes);
  const publicValues = AbiCoder.defaultAbiCoder().encode(
    [PUBLIC_VALUES_TYPE],
    [{ inputCommitment: args.inputCommitment, outputCommitment }],
  );
  return { publicValues, proofBytes: "0x", statesBytes };
}
