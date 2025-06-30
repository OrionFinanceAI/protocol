import * as dotenv from "dotenv";
import { ethers, network } from "hardhat";

dotenv.config();

function getUniverseList(): string[] {
  const universeList = process.env.UNIVERSE_LIST;
  if (!universeList) {
    throw new Error("UNIVERSE_LIST environment variable is required");
  }
  return universeList.split(",").map((address) => address.trim().replace(/['"]/g, ""));
}

function validateAddress(address: string, name: string): string {
  if (!ethers.isAddress(address)) {
    throw new Error(`Invalid ${name} address: ${address}`);
  }
  return address;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  console.log("Using deployer:", deployerAddress);
  console.log("Network:", network.name);

  const {
    CONFIG_ADDRESS,
    UNDERLYING_ASSET,
    INTERNAL_ORCHESTRATOR_ADDRESS,
    LIQUIDITY_ORCHESTRATOR_ADDRESS,
    FACTORY_ADDRESS,
    ORACLE_REGISTRY_ADDRESS,
  } = process.env;

  if (
    !CONFIG_ADDRESS ||
    !UNDERLYING_ASSET ||
    !INTERNAL_ORCHESTRATOR_ADDRESS ||
    !LIQUIDITY_ORCHESTRATOR_ADDRESS ||
    !FACTORY_ADDRESS ||
    !ORACLE_REGISTRY_ADDRESS
  ) {
    throw new Error("Missing one or more required env variables");
  }

  // Validate all addresses
  const configAddress = validateAddress(CONFIG_ADDRESS, "config");
  const underlyingAsset = validateAddress(UNDERLYING_ASSET, "underlying asset");
  const internalOrchestrator = validateAddress(INTERNAL_ORCHESTRATOR_ADDRESS, "internal orchestrator");
  const liquidityOrchestrator = validateAddress(LIQUIDITY_ORCHESTRATOR_ADDRESS, "liquidity orchestrator");
  const factoryAddress = validateAddress(FACTORY_ADDRESS, "factory");
  const oracleRegistryAddress = validateAddress(ORACLE_REGISTRY_ADDRESS, "oracle registry");

  // Get the config contract
  const config = await ethers.getContractAt("OrionConfig", configAddress);

  // Verify the owner
  const owner = await config.owner();
  console.log("Current config owner:", owner);
  console.log("Deployer address:", deployerAddress);

  if (owner.toLowerCase() !== deployerAddress.toLowerCase()) {
    throw new Error(`Owner mismatch. Expected ${deployerAddress} but got ${owner}`);
  }

  console.log("📦 Setting protocol parameters...");
  const setTx = await config.setProtocolParams(
    underlyingAsset,
    internalOrchestrator,
    liquidityOrchestrator,
    18,
    9, // Biggest integer that can be represented in 32 bits
    factoryAddress,
    oracleRegistryAddress,
  );
  await setTx.wait();
  console.log("✅ Protocol parameters updated");

  const universeList = getUniverseList();
  console.log(`🏭 Setting universe list to ${universeList.length} vaults...`);

  for (const asset of universeList) {
    const validatedAsset = validateAddress(asset, "universe asset");
    const isAlreadyWhitelisted = await config.isWhitelisted(validatedAsset);
    if (!isAlreadyWhitelisted) {
      console.log(`Adding ${validatedAsset} to config whitelist...`);
      const tx = await config.addWhitelistedAsset(validatedAsset);
      await tx.wait();
      console.log(`✅ Added ${validatedAsset} to config whitelist`);
    } else {
      console.log(`ℹ️  ${validatedAsset} is already in config whitelist.`);
    }
  }
}

main().catch((error) => {
  console.error("❌ Failed to add assets:", error);
  process.exitCode = 1;
});
