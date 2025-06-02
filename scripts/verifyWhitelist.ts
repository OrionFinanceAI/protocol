// scripts/verifyWhitelist.ts

import { run } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const whitelistAddress = process.env.WHITELIST_ADDRESS;

  if (!whitelistAddress) {
    throw new Error("❌ WHITELIST_ADDRESS is not set in the .env file.");
  }

  await run("verify:verify", {
    address: whitelistAddress,
    constructorArguments: [],
  });

  console.log("✅ Verification submitted for UniverseERC4626Whitelist.");
}

main().catch((err) => {
  console.error("❌ Verification failed:", err);
  process.exitCode = 1;
});
