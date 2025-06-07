import * as dotenv from "dotenv";
import { ethers } from "hardhat";

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
    FACTORY_ADDRESS,
  } = process.env;

  if (
    !CONFIG_ADDRESS ||
    !UNDERLYING_ASSET ||
    !INTERNAL_ORCHESTRATOR_ADDRESS ||
    !LIQUIDITY_ORCHESTRATOR_ADDRESS ||
    !ORACLE_ADDRESS ||
    !FHE_PUBLIC_CID ||
    !FACTORY_ADDRESS
  ) {
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
    FHE_PUBLIC_CID,
  );
  await setTx.wait();
  console.log("✅ Protocol parameters updated");

  // Set vault factory address
  const currentFactory = await config.vaultFactory();
  if (currentFactory === ethers.constants.AddressZero) {
    console.log(`🏭 Setting vault factory address to ${FACTORY_ADDRESS}...`);
    const factoryTx = await config.setVaultFactory(FACTORY_ADDRESS);
    await factoryTx.wait();
    console.log("✅ Vault factory address set");
  } else {
    console.log(`ℹ️ Vault factory already set to ${currentFactory}`);
  }

  // Add universe list to whitelist
  const universeList = getUniverseList();
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
