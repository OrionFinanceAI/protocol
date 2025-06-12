import * as dotenv from "dotenv";
import { run } from "hardhat";

dotenv.config();

async function main() {
  const vaultAddress = process.env.ORION_VAULT_ADDRESS;
  const curatorAddress = process.env.CURATOR_ADDRESS;
  const configAddress = process.env.CONFIG_ADDRESS;

  if (!vaultAddress || !curatorAddress || !configAddress) {
    throw new Error("❌ ORION_VAULT_ADDRESS, CURATOR_ADDRESS, and CONFIG_ADDRESS must be set in the .env file.");
  }

  await run("verify:verify", {
    address: vaultAddress,
    constructorArguments: [curatorAddress, configAddress],
  });

  console.log("✅ Verification submitted for OrionVault.");
}

main().catch((err) => {
  console.error("❌ Verification failed:", err);
  process.exitCode = 1;
});
