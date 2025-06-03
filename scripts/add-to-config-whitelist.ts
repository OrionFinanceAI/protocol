import { ethers } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Using deployer:", deployer.address);

  const configAddress = process.env.CONFIG_ADDRESS;
  if (!configAddress) {
    throw new Error("Please set CONFIG_ADDRESS in your .env file");
  }
  console.log("Using Config contract at:", configAddress);

  const UNIVERSE_LIST = [
    "0x37D0d043caA1A0fBccf8DD097EEc50b09B95dF6f",
    "0xCCA69D92CB2c0d44Bb787332E8f233549252CB05"
  ];

  const config = await ethers.getContractAt("OrionConfig", configAddress);

  for (const vault of UNIVERSE_LIST) {
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
