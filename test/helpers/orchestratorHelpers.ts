import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { time } from "hardhat";

import { LiquidityOrchestrator } from "../../typechain-types";

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
export async function advanceEpochTime(liquidityOrchestrator: LiquidityOrchestrator): Promise<void> {
  const epochDuration = await liquidityOrchestrator.epochDuration();
  await time.increase(epochDuration + 1n);
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
 * Process full Liquidity Orchestrator epoch (from Idle back to Idle)
 */
export async function processFullEpoch(
  liquidityOrchestrator: LiquidityOrchestrator,
  automationRegistry: SignerWithAddress,
): Promise<void> {
  // Verify starting from Idle
  expect(await liquidityOrchestrator.currentPhase()).to.equal(0n);

  // Advance time
  await advanceEpochTime(liquidityOrchestrator);

  const [upkeepNeeded, performData] = await liquidityOrchestrator.checkUpkeep("0x");
  void expect(upkeepNeeded).to.be.true;

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
