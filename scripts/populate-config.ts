import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

function getUniverseList(): string[] {
  const list = process.env.UNIVERSE_LIST;
  if (!list) throw new Error("Please set UNIVERSE_LIST in your .env file");
  return list
    .split(",")
    .map((addr) => addr.trim())
    .filter((addr) => addr.length > 0);
}


async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Using deployer:", deployer.address);

  const {
    CONFIG_ADDRESS,
    UNDERLYING_ASSET,
    INTERNAL_ORCHESTRATOR_ADDRESS,
    LIQUIDITY_ORCHESTRATOR_ADDRESS,
    ORACLE_ADDRESS,
    FHE_PUBLIC_CID,
  } = process.env;

  if (!CONFIG_ADDRESS || !UNDERLYING_ASSET || !INTERNAL_ORCHESTRATOR_ADDRESS || !LIQUIDITY_ORCHESTRATOR_ADDRESS || !ORACLE_ADDRESS || !FHE_PUBLIC_CID) {
    throw new Error("Missing one or more required env variables");
  }

  const config = await ethers.getContractAt("OrionConfig", CONFIG_ADDRESS);

  // Set protocol params
  console.log("📦 Setting protocol parameters...");
  const setTx = await config.setProtocolParams(
    UNDERLYING_ASSET,
    INTERNAL_ORCHESTRATOR_ADDRESS,
    LIQUIDITY_ORCHESTRATOR_ADDRESS,
    ORACLE_ADDRESS,
    FHE_PUBLIC_CID
  );
  await setTx.wait();
  console.log("✅ Protocol parameters updated");

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
