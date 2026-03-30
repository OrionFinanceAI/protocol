import { networkHelpers } from "./hh";

/**
 * Reset the Hardhat network to a clean state.
 * Call in a root-level before() hook so each test file starts with a fresh chain.
 * Preserves fork configuration if the network was started with forking enabled.
 */
export async function resetNetwork(): Promise<void> {
  await networkHelpers.clearSnapshots();
}
