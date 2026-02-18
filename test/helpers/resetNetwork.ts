import { network } from "hardhat";

/**
 * Reset the Hardhat network to a clean state.
 * Call in a root-level before() hook so each test file starts with a fresh chain.
 * Preserves fork configuration if the network was started with forking enabled.
 */
export async function resetNetwork(): Promise<void> {
  const hardhatNetworkConfig = network.config as unknown as Record<string, unknown>;
  const forking = hardhatNetworkConfig.forking as { url?: string; blockNumber?: number } | undefined;

  const resetParams = forking?.url
    ? {
        forking: {
          jsonRpcUrl: forking.url,
          ...(forking.blockNumber !== undefined ? { blockNumber: forking.blockNumber } : {}),
        },
      }
    : {};

  await network.provider.send("hardhat_reset", [resetParams]);
}
