import * as dotenv from "dotenv";
import { run } from "hardhat";

dotenv.config();

async function main() {
  const configAddress = process.env.CONFIG_ADDRESS;
  const fhePublicCID = process.env.FHE_PUBLIC_CID;

  if (!configAddress) {
    throw new Error("❌ CONFIG_ADDRESS is not set in the .env file.");
  }

  await run("verify:verify", {
    address: configAddress,
    constructorArguments: [fhePublicCID],
  });

  console.log("✅ Verification submitted for OrionConfig.");
}

main().catch((err) => {
  console.error("❌ Verification failed:", err);
  process.exitCode = 1;
});
