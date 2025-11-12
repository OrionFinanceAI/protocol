import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";

import {
  InternalStatesOrchestrator,
  LiquidityOrchestrator,
  OrionConfig,
  OrionTransparentVault,
} from "../../typechain-types";

/**
 * @title Orchestrator Test Helper Functions
 * @notice Shared utilities for orchestrator testing to eliminate duplication
 */

// =============================================================================
// EPOCH ADVANCEMENT HELPERS
// =============================================================================

/**
 * Advance blockchain time to trigger next epoch
 */
export async function advanceEpochTime(internalStatesOrchestrator: InternalStatesOrchestrator): Promise<void> {
  const epochDuration = await internalStatesOrchestrator.epochDuration();
  await time.increase(epochDuration + 1n);
}

/**
 * Process all minibatches in current ISO phase until phase changes
 * @param internalStatesOrchestrator The ISO contract instance
 * @param automationRegistry Signer that can call performUpkeep
 */
export async function processCurrentISOPhase(
  internalStatesOrchestrator: InternalStatesOrchestrator,
  automationRegistry: SignerWithAddress,
): Promise<void> {
  const initialPhase = await internalStatesOrchestrator.currentPhase();
  let currentPhase = initialPhase;

  while (currentPhase === initialPhase) {
    const [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
    if (!upkeepNeeded) break;

    await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);
    currentPhase = await internalStatesOrchestrator.currentPhase();
  }
}

/**
 * Process all minibatches in current LO phase until phase changes
 * @param liquidityOrchestrator The LO contract instance
 * @param automationRegistry Signer that can call performUpkeep
 */
export async function processCurrentLOPhase(
  liquidityOrchestrator: LiquidityOrchestrator,
  automationRegistry: SignerWithAddress,
): Promise<void> {
  const initialPhase = await liquidityOrchestrator.currentPhase();
  let currentPhase = initialPhase;

  while (currentPhase === initialPhase) {
    const [upkeepNeeded, performData] = await liquidityOrchestrator.checkUpkeep("0x");
    if (!upkeepNeeded) break;

    await liquidityOrchestrator.connect(automationRegistry).performUpkeep(performData);
    currentPhase = await liquidityOrchestrator.currentPhase();
  }
}

/**
 * Advance ISO to a specific phase by processing all intermediate phases
 * @param targetPhase Target phase number (0=Idle, 1=Preprocessing, 2=Buffering, 3=Postprocessing, 4=BuildingOrders, 5=SellingLeg, 6=BuyingLeg)
 */
export async function advanceISOToPhase(
  internalStatesOrchestrator: InternalStatesOrchestrator,
  automationRegistry: SignerWithAddress,
  targetPhase: number,
): Promise<void> {
  let currentPhase = await internalStatesOrchestrator.currentPhase();

  while (currentPhase < BigInt(targetPhase)) {
    await processCurrentISOPhase(internalStatesOrchestrator, automationRegistry);
    currentPhase = await internalStatesOrchestrator.currentPhase();

    // Prevent infinite loop
    if (currentPhase === 0n && targetPhase > 0) {
      throw new Error(`ISO returned to Idle before reaching target phase ${targetPhase}`);
    }
  }

  expect(await internalStatesOrchestrator.currentPhase()).to.equal(BigInt(targetPhase));
}

/**
 * Advance LO to a specific phase
 * @param targetPhase Target phase (0=Idle, 1=FulfillDepositAndRedeem, 2=SellingLeg, 3=BuyingLeg)
 */
export async function advanceLOToPhase(
  liquidityOrchestrator: LiquidityOrchestrator,
  automationRegistry: SignerWithAddress,
  targetPhase: number,
): Promise<void> {
  let currentPhase = await liquidityOrchestrator.currentPhase();

  while (currentPhase < BigInt(targetPhase)) {
    await processCurrentLOPhase(liquidityOrchestrator, automationRegistry);
    currentPhase = await liquidityOrchestrator.currentPhase();

    // Prevent infinite loop
    if (currentPhase === 0n && targetPhase > 0) {
      throw new Error(`LO returned to Idle before reaching target phase ${targetPhase}`);
    }
  }

  expect(await liquidityOrchestrator.currentPhase()).to.equal(BigInt(targetPhase));
}

/**
 * Process complete Internal States Orchestrator epoch (from Idle back to Idle)
 */
export async function processISOEpoch(
  internalStatesOrchestrator: InternalStatesOrchestrator,
  automationRegistry: SignerWithAddress,
): Promise<void> {
  // Verify starting from Idle
  expect(await internalStatesOrchestrator.currentPhase()).to.equal(0n);

  // Advance time
  await advanceEpochTime(internalStatesOrchestrator);

  // Check upkeep needed
  const [upkeepNeeded, performData] = await internalStatesOrchestrator.checkUpkeep("0x");
  void expect(upkeepNeeded).to.be.true;

  // Start epoch
  await internalStatesOrchestrator.connect(automationRegistry).performUpkeep(performData);

  // Process all phases until back to Idle
  let currentPhase = await internalStatesOrchestrator.currentPhase();
  while (currentPhase !== 0n) {
    await processCurrentISOPhase(internalStatesOrchestrator, automationRegistry);
    currentPhase = await internalStatesOrchestrator.currentPhase();
  }

  expect(await internalStatesOrchestrator.currentPhase()).to.equal(0n);
}

/**
 * Process Liquidity Orchestrator epoch (from Idle back to Idle)
 */
export async function processLOEpoch(
  liquidityOrchestrator: LiquidityOrchestrator,
  automationRegistry: SignerWithAddress,
): Promise<void> {
  const [upkeepNeeded, performData] = await liquidityOrchestrator.checkUpkeep("0x");
  if (!upkeepNeeded) {
    // LO upkeep not triggered (epoch counter hasn't changed)
    return;
  }

  // Start LO epoch
  await liquidityOrchestrator.connect(automationRegistry).performUpkeep(performData);

  // Process all LO phases until back to Idle
  let currentPhase = await liquidityOrchestrator.currentPhase();
  while (currentPhase !== 0n) {
    await processCurrentLOPhase(liquidityOrchestrator, automationRegistry);
    currentPhase = await liquidityOrchestrator.currentPhase();
  }

  expect(await liquidityOrchestrator.currentPhase()).to.equal(0n);
}

/**
 * Process complete full epoch (ISO + LO)
 */
export async function processFullEpoch(
  internalStatesOrchestrator: InternalStatesOrchestrator,
  liquidityOrchestrator: LiquidityOrchestrator,
  automationRegistry: SignerWithAddress,
): Promise<void> {
  await processISOEpoch(internalStatesOrchestrator, automationRegistry);
  await processLOEpoch(liquidityOrchestrator, automationRegistry);

  // Verify both back to Idle
  expect(await internalStatesOrchestrator.currentPhase()).to.equal(0n);
  expect(await liquidityOrchestrator.currentPhase()).to.equal(0n);
}

// =============================================================================
// PORTFOLIO VALIDATION HELPERS
// =============================================================================

/**
 * Validate that vault's portfolio matches its intent weights
 * @param vault The vault to validate
 * @param vaultName Name for logging
 * @param internalStatesOrchestrator ISO instance for price lookups
 * @param orionConfig Config instance for decimals
 */
export async function validatePortfolioMatchesIntent(
  vault: OrionTransparentVault,
  vaultName: string,
  internalStatesOrchestrator: InternalStatesOrchestrator,
  orionConfig: OrionConfig,
): Promise<void> {
  const [intentTokens, intentWeights] = await vault.getIntent();
  const [portfolioTokens, portfolioShares] = await vault.getPortfolio();

  const vaultTotalAssets = await vault.totalAssets();
  const curatorIntentDecimals = await orionConfig.curatorIntentDecimals();
  const intentDecimals = 10n ** BigInt(curatorIntentDecimals);
  const priceAdapterPrecision = 10n ** BigInt(await orionConfig.priceAdapterDecimals());

  const expectedShares = new Map<string, bigint>();

  for (let i = 0; i < intentTokens.length; i++) {
    const token = intentTokens[i];
    const weight = intentWeights[i];
    const price = await internalStatesOrchestrator.getPriceOf(token);

    const value = (BigInt(weight) * vaultTotalAssets) / intentDecimals;
    const shares = (value * priceAdapterPrecision) / price;

    expectedShares.set(token, shares);
  }

  console.log(`\n${vaultName} Portfolio Validation:`);
  for (let i = 0; i < portfolioTokens.length; i++) {
    const token = portfolioTokens[i];
    const actualShares = portfolioShares[i];
    const expected = expectedShares.get(token);

    console.log(`  Token ${token}: Expected ${expected?.toString()}, Actual ${actualShares.toString()}`);

    void expect(expected).to.not.be.undefined;
    expect(actualShares).to.equal(expected!);
  }
}

/**
 * Validate buffer amount matches expected value based on target ratio
 */
export async function validateBufferAmount(
  internalStatesOrchestrator: InternalStatesOrchestrator,
  liquidityOrchestrator: LiquidityOrchestrator,
  expectedBaseAssets: bigint,
): Promise<bigint> {
  const bufferAmount = await internalStatesOrchestrator.bufferAmount();
  const targetBufferRatio = await liquidityOrchestrator.targetBufferRatio();
  const BASIS_POINTS_FACTOR = await internalStatesOrchestrator.BASIS_POINTS_FACTOR();

  const expectedBuffer = (expectedBaseAssets * BigInt(targetBufferRatio)) / BASIS_POINTS_FACTOR;

  expect(bufferAmount).to.equal(expectedBuffer);

  return bufferAmount;
}

// =============================================================================
// VAULT ASSERTIONS
// =============================================================================

/**
 * Assert vault total assets equals expected value
 */
export async function assertVaultTotalAssets(
  vault: OrionTransparentVault,
  expectedAssets: bigint,
  vaultName?: string,
): Promise<void> {
  const actualAssets = await vault.totalAssets();
  expect(actualAssets).to.equal(
    expectedAssets,
    `${vaultName || "Vault"} total assets mismatch: expected ${expectedAssets}, got ${actualAssets}`,
  );
}

/**
 * Assert vault has correct fee amounts
 */
export async function assertVaultFees(
  vault: OrionTransparentVault,
  expectedCuratorFees: bigint,
  vaultName?: string,
): Promise<void> {
  const actualCuratorFees = await vault.pendingCuratorFees();
  expect(actualCuratorFees).to.equal(
    expectedCuratorFees,
    `${vaultName || "Vault"} curator fees mismatch: expected ${expectedCuratorFees}, got ${actualCuratorFees}`,
  );
}

/**
 * Assert protocol fees are correct
 */
export async function assertProtocolFees(
  internalStatesOrchestrator: InternalStatesOrchestrator,
  expectedFees: bigint,
): Promise<void> {
  const actualFees = await internalStatesOrchestrator.pendingProtocolFees();
  expect(actualFees).to.equal(expectedFees, `Protocol fees mismatch: expected ${expectedFees}, got ${actualFees}`);
}

// =============================================================================
// SYSTEM STATE ASSERTIONS
// =============================================================================

/**
 * Assert system is in Idle state
 */
export async function assertSystemIdle(
  internalStatesOrchestrator: InternalStatesOrchestrator,
  liquidityOrchestrator: LiquidityOrchestrator,
  orionConfig: OrionConfig,
): Promise<void> {
  expect(await internalStatesOrchestrator.currentPhase()).to.equal(0n, "ISO should be in Idle phase");
  expect(await liquidityOrchestrator.currentPhase()).to.equal(0n, "LO should be in Idle phase");
  void expect(await orionConfig.isSystemIdle()).to.be.true;
}

/**
 * Assert ISO is in specific phase
 */
export async function assertISOPhase(
  internalStatesOrchestrator: InternalStatesOrchestrator,
  expectedPhase: number,
  phaseName?: string,
): Promise<void> {
  const actualPhase = await internalStatesOrchestrator.currentPhase();
  expect(actualPhase).to.equal(
    BigInt(expectedPhase),
    `ISO phase mismatch: expected ${expectedPhase}${phaseName ? ` (${phaseName})` : ""}, got ${actualPhase}`,
  );
}

/**
 * Assert LO is in specific phase
 */
export async function assertLOPhase(
  liquidityOrchestrator: LiquidityOrchestrator,
  expectedPhase: number,
  phaseName?: string,
): Promise<void> {
  const actualPhase = await liquidityOrchestrator.currentPhase();
  expect(actualPhase).to.equal(
    BigInt(expectedPhase),
    `LO phase mismatch: expected ${expectedPhase}${phaseName ? ` (${phaseName})` : ""}, got ${actualPhase}`,
  );
}

// =============================================================================
// FORMATTING HELPERS
// =============================================================================

/**
 * Format amount for logging
 */
export function formatAmount(amount: bigint, decimals: number, symbol: string = ""): string {
  return `${ethers.formatUnits(amount, decimals)} ${symbol}`.trim();
}
