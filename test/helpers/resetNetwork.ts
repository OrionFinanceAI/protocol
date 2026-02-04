import { network } from "hardhat";

/**
 * Reset the Hardhat network to a clean state.
 * Call in a root-level before() hook so each test file starts with a fresh chain
 */
export async function resetNetwork(): Promise<void> {
  await network.provider.send("hardhat_reset", []);
}
