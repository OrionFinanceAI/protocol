import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { time } from "hardhat";

import { InternalStatesOrchestrator, LiquidityOrchestrator } from "../../typechain-types";

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
