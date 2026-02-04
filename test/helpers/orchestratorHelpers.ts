import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";

import { LiquidityOrchestrator } from "../../typechain-types";
import { readFileSync } from "fs";
import { join } from "path";

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

interface Groth16Fixture {
  vkey: string;
  publicValues: string;
  proofBytes: string;
  statesBytes: string;
}

/**
 * Process full Liquidity Orchestrator epoch (from Idle back to Idle)
 */
export async function processFullEpoch(
  liquidityOrchestrator: LiquidityOrchestrator,
  automationRegistry: SignerWithAddress,
  fixtureName: string,
): Promise<void> {
  // Verify starting from Idle
  expect(await liquidityOrchestrator.currentPhase()).to.equal(0n);

  // Advance time
  await advanceEpochTime(liquidityOrchestrator);

  // Process first upkeep (phase 0 -> 1): always use dummy proofs
  await liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x", "0x", "0x");

  // Load fixture once per epoch (reused for all non–phase-1 upkeeps)
  const fixturePath = join(__dirname, `../fixtures/${fixtureName}.json`);
  let fixture: Groth16Fixture;
  try {
    fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
  } catch (err) {
    console.log(
      `🚨 Fixture ${fixtureName} not found or failed to load/parse. Generate proof now and press ENTER to retry...`,
    );
    await new Promise((resolve) => process.stdin.once("data", resolve));
    throw err;
  }

  // Process all remaining LO phases until back to Idle
  let currentPhase = await liquidityOrchestrator.currentPhase();
  while (currentPhase !== 0n) {
    if (currentPhase === 1n) {
      await liquidityOrchestrator.connect(automationRegistry).performUpkeep("0x", "0x", "0x");
    } else {
      await liquidityOrchestrator
        .connect(automationRegistry)
        .performUpkeep(fixture.publicValues, fixture.proofBytes, fixture.statesBytes);
    }

    currentPhase = await liquidityOrchestrator.currentPhase();
  }

  expect(await liquidityOrchestrator.currentPhase()).to.equal(0n);
}
