import { ethers } from "./hh";

/** Canonical mainnet USDC — used to verify fork state is actually loaded. */
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

export function isForkEnvConfigured(): boolean {
  return process.env.FORK_MAINNET === "true" && Boolean(process.env.MAINNET_RPC_URL);
}

/**
 * Skip the current mocha suite unless mainnet forking is configured *and* active.
 * Env alone is not enough: coverage / misconfigured networks can set FORK_MAINNET
 * without loading mainnet state, which produces empty returndata on live addresses.
 */
export async function skipUnlessMainnetFork(ctx: Mocha.Context): Promise<void> {
  if (!isForkEnvConfigured()) {
    ctx.skip();
  }

  const code = await ethers.provider.getCode(MAINNET_USDC);
  if (!code || code === "0x") {
    console.warn(
      "FORK_MAINNET is set but mainnet state is not available (e.g. coverage without forking) — skipping fork tests",
    );
    ctx.skip();
  }
}
