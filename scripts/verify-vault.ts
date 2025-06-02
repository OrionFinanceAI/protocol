import { run } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS;
  const mockUsdcAddress = process.env.MOCK_USDC_ADDRESS;
  const curatorAddress = process.env.CURATOR_ADDRESS;
  const fheCID = process.env.FHE_PUBLIC_KEY_CID;

  if (!vaultAddress || !mockUsdcAddress || !curatorAddress || !fheCID) {
    throw new Error("Missing one or more env variables");
  }

  await run("verify:verify", {
    address: vaultAddress,
    constructorArguments: [mockUsdcAddress, curatorAddress, fheCID],
  });

  console.log("✅ Verification submitted.");
}

main().catch((err) => {
  console.error("❌ Verification failed:", err);
  process.exitCode = 1;
});
