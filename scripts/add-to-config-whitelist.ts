import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

function getUniverseList(): string[] {
  const list = process.env.UNIVERSE_LIST;
  if (!list) {
    throw new Error("Please set UNIVERSE_LIST in your .env file");
  }
  return list.split(",").map(addr => addr.trim()).filter(addr => addr.length > 0);
}


async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Using deployer:", deployer.address);

  const configAddress = process.env.CONFIG_ADDRESS;
  if (!configAddress) {
    throw new Error("Please set CONFIG_ADDRESS in your .env file");
  }
  console.log("Using Config contract at:", configAddress);

  const config = await ethers.getContractAt("OrionConfig", configAddress);

  const universeList = getUniverseList();

  for (const vault of universeList) {
    const isAlreadyWhitelisted = await config.isWhitelisted(vault);
    if (!isAlreadyWhitelisted) {
      console.log(`Adding ${vault} to config whitelist...`);
      const tx = await config.addVault(vault);
      await tx.wait();
      console.log(`✅ Added ${vault}`);
    } else {
      console.log(`ℹ️  ${vault} is already in config whitelist.`);
    }
  }
}

main().catch((error) => {
  console.error("❌ Failed to add vaults:", error);
  process.exitCode = 1;
});
