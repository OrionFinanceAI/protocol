import { run } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const vaultAddress = process.env.CURATED_VAULT_ADDRESS;
  const mockUsdcAddress = process.env.MOCK_USDC_ADDRESS;
  const curatorAddress = process.env.CURATOR_ADDRESS;
  const fheClientKeyCID = process.env.FHE_CLIENT_KEY_CID;
  const whitelistAddress = process.env.WHITELIST_ADDRESS;

  if (!vaultAddress || !mockUsdcAddress || !curatorAddress || !fheClientKeyCID || !whitelistAddress) {
    throw new Error("Missing one or more env variables");
  }

  await run("verify:verify", {
    address: vaultAddress,
    constructorArguments: [mockUsdcAddress, curatorAddress, fheClientKeyCID, whitelistAddress],
  });

  console.log("✅ Verification submitted.");
}

main().catch((err) => {
  console.error("❌ Verification failed:", err);
  process.exitCode = 1;
});
