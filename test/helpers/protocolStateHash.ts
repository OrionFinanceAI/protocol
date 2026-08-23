import { ethers } from "./hh";

/** Mirrors LO `_buildProtocolStateHash` abi.encode field order (15 fields). */
export function encodeProtocolStateTuple(fields: {
  activeNettingFeeCoefficient: bigint;
  activeRsFeeCoefficient: bigint;
  maxFulfillBatchSize: bigint;
  targetBufferRatio: bigint;
  priceAdapterDecimals: number;
  strategistIntentDecimals: number;
  epochDuration: bigint;
  assets: string[];
  tokenDecimals: number[];
  riskFreeRate: bigint;
  decommissioningAssets: string[];
  failedEpochTokens: string[];
  initialEpochBufferAmount: bigint;
  bufferAmount: bigint;
  loBalanceUnderlying: bigint;
}): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "uint16",
      "uint16",
      "uint256",
      "uint256",
      "uint8",
      "uint8",
      "uint32",
      "address[]",
      "uint8[]",
      "uint16",
      "address[]",
      "address[]",
      "uint256",
      "uint256",
      "uint256",
    ],
    [
      fields.activeNettingFeeCoefficient,
      fields.activeRsFeeCoefficient,
      fields.maxFulfillBatchSize,
      fields.targetBufferRatio,
      fields.priceAdapterDecimals,
      fields.strategistIntentDecimals,
      fields.epochDuration,
      fields.assets,
      fields.tokenDecimals,
      fields.riskFreeRate,
      fields.decommissioningAssets,
      fields.failedEpochTokens,
      fields.initialEpochBufferAmount,
      fields.bufferAmount,
      fields.loBalanceUnderlying,
    ],
  );
}

export function hashProtocolState(fields: Parameters<typeof encodeProtocolStateTuple>[0]): string {
  return ethers.keccak256(encodeProtocolStateTuple(fields));
}

/** Mirrors LO vault-leaf abi.encode (13 fields). */
export function hashVaultLeaf(fields: {
  vaultAddress: string;
  isEncrypted: boolean;
  isDecommissioning: boolean;
  feeType: number;
  performanceFee: bigint;
  managementFee: bigint;
  highWaterMark: bigint;
  pendingRedeemsHash: string;
  pendingDeposit: bigint;
  totalSupply: bigint;
  totalAssets: bigint;
  portfolioHash: string;
  intentHash: string;
}): string {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "address",
      "bool",
      "bool",
      "uint8",
      "uint256",
      "uint256",
      "uint256",
      "bytes32",
      "uint256",
      "uint256",
      "uint256",
      "bytes32",
      "bytes32",
    ],
    [
      fields.vaultAddress,
      fields.isEncrypted,
      fields.isDecommissioning,
      fields.feeType,
      fields.performanceFee,
      fields.managementFee,
      fields.highWaterMark,
      fields.pendingRedeemsHash,
      fields.pendingDeposit,
      fields.totalSupply,
      fields.totalAssets,
      fields.portfolioHash,
      fields.intentHash,
    ],
  );
  return ethers.keccak256(encoded);
}

export function pendingRedeemsHash(shares: bigint[]): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256[]"], [shares]));
}
