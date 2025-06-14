import * as dotenv from "dotenv";
import { ethers } from "hardhat";

dotenv.config();

function getUniverseList(): string[] {
  const universeList = process.env.UNIVERSE_LIST;
  if (!universeList) {
    throw new Error("UNIVERSE_LIST environment variable is required");
  }
  return universeList.split(",").map((address) => address.trim());
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Using deployer:", await deployer.getAddress());

  const {
    CONFIG_ADDRESS,
    UNDERLYING_ASSET,
    INTERNAL_ORCHESTRATOR_ADDRESS,
    LIQUIDITY_ORCHESTRATOR_ADDRESS,
    ORACLE_ADDRESS,
    FHE_PUBLIC_CID,
    FACTORY_ADDRESS,
    UNIVERSE_LIST,
  } = process.env;

  if (
    !CONFIG_ADDRESS ||
    !UNDERLYING_ASSET ||
    !INTERNAL_ORCHESTRATOR_ADDRESS ||
    !LIQUIDITY_ORCHESTRATOR_ADDRESS ||
    !ORACLE_ADDRESS ||
    !FHE_PUBLIC_CID ||
    !FACTORY_ADDRESS ||
    !UNIVERSE_LIST
  ) {
    throw new Error("Missing one or more required env variables");
  }

  const config = await ethers.getContractAt("OrionConfig", CONFIG_ADDRESS);

  console.log("📦 Setting protocol parameters...");
  const setTx = await config.setProtocolParams(
    UNDERLYING_ASSET,
    INTERNAL_ORCHESTRATOR_ADDRESS,
    LIQUIDITY_ORCHESTRATOR_ADDRESS,
    ORACLE_ADDRESS,
    9, // Biggest integer that can be represented in 32 bits
    FHE_PUBLIC_CID,
  );
  await setTx.wait();
  console.log("✅ Protocol parameters updated");

  console.log(`🏭 Setting vault factory address to ${FACTORY_ADDRESS}...`);
  const factoryTx = await config.setVaultFactory(FACTORY_ADDRESS);
  await factoryTx.wait();
  console.log("✅ Vault factory address set");

  const universeList = getUniverseList();

  console.log(`🏭 Setting universe list to ${universeList.length} vaults...`);

  for (const vault of universeList) {
    const isAlreadyWhitelisted = await config.isWhitelisted(vault);
    if (!isAlreadyWhitelisted) {
      console.log(`Adding ${vault} to config whitelist...`);
      const tx = await config.addWhitelistedVault(vault);
      await tx.wait();
      console.log(`✅ Added ${vault} to config whitelist`);
    } else {
      console.log(`ℹ️  ${vault} is already in config whitelist.`);
    }
  }
}

main().catch((error) => {
  console.error("❌ Failed to add vaults:", error);
  process.exitCode = 1;
});
