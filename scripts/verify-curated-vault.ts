import { run } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const vaultAddress = process.env.CURATED_VAULT_ADDRESS;
  const mockUsdcAddress = process.env.MOCK_USDC_ADDRESS;
  const curatorAddress = process.env.CURATOR_ADDRESS;
  const fheContextPublicCID = process.env.FHE_CONTEXT_PUBLIC_CID;
  const whitelistAddress = process.env.WHITELIST_ADDRESS;

  if (!vaultAddress || !mockUsdcAddress || !curatorAddress || !fheContextPublicCID || !whitelistAddress) {
    throw new Error("Missing one or more env variables");
  }

  await run("verify:verify", {
    address: vaultAddress,
    constructorArguments: [mockUsdcAddress, curatorAddress, fheContextPublicCID, whitelistAddress],
  });

  console.log("✅ Verification submitted.");
}

main().catch((err) => {
  console.error("❌ Verification failed:", err);
  process.exitCode = 1;
});
