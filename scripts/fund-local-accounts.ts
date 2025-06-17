import * as dotenv from "dotenv";
import { ethers, network } from "hardhat";

dotenv.config();

const addresses = [
  process.env.DEPLOYER_ADDRESS,
  process.env.CURATOR_ADDRESS,
  process.env.LP_ADDRESS,
  process.env.CHAINLINK_AUTOMATION_REGISTRY_ADDRESS,
];

// Amount to fund in ETH
const amountInEth = "1000";

async function main() {
  if (network.name !== "localhost") {
    throw new Error("⚠️  This script should only be run on the localhost network.");
  }

  // ethers v6 uses parseEther the same way, but BigInt internally
  const amount = ethers.parseEther(amountInEth);

  for (const address of addresses) {
    console.log(`⛽ Funding ${address} with ${amountInEth} ETH`);

    // hardhat_setBalance expects hex string with 0x prefix — amount is BigInt, convert to hex string:
    await network.provider.send("hardhat_setBalance", [address, "0x" + amount.toString(16)]);
  }

  console.log("✅ All addresses funded.");
}

main().catch((error) => {
  console.error("❌ Funding failed:", error);
  process.exitCode = 1;
});
