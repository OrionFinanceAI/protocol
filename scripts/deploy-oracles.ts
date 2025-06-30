import * as dotenv from "dotenv";
import { ethers } from "hardhat";

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
  console.log("Deploying Oracles with:", await deployer.getAddress());

  const universeList = getUniverseList();
  console.log(`🏭 Deploying oracles for ${universeList.length} assets...`);

  const deployedOracles: { asset: string; oracle: string }[] = [];

  for (const asset of universeList) {
    try {
      // Validate the asset address
      const validatedAsset = validateAddress(asset, "asset");

      console.log(`\n📊 Deploying UniverseOracle for asset: ${validatedAsset}`);

      // Deploy the UniverseOracle contract
      const UniverseOracle = await ethers.getContractFactory("UniverseOracle");
      const oracle = await UniverseOracle.deploy();
      await oracle.waitForDeployment();

      const oracleAddress = await oracle.getAddress();
      console.log(`✅ UniverseOracle deployed at: ${oracleAddress}`);

      // Initialize the oracle with a random initial price (between 1 and 100)
      const initialPrice = Math.floor(Math.random() * 100) + 1;
      const deployerAddress = await deployer.getAddress();

      console.log(`🔧 Initializing oracle with price: ${initialPrice}`);
      const initTx = await oracle.initialize(validatedAsset, initialPrice, deployerAddress);
      await initTx.wait();

      console.log(`✅ Oracle initialized successfully`);

      deployedOracles.push({
        asset: validatedAsset,
        oracle: oracleAddress,
      });
    } catch (error) {
      console.error(`❌ Failed to deploy oracle for asset ${asset}:`, error);
      throw error;
    }
  }

  console.log(`\n🎉 Deployment Summary:`);
  console.log(`Total oracles deployed: ${deployedOracles.length}`);
  deployedOracles.forEach(({ asset, oracle }) => {
    console.log(`  Asset: ${asset} -> Oracle: ${oracle}`);
  });

  console.log(`\n📋 Oracle addresses for configuration:`);
  const oracleAddresses = deployedOracles.map(({ oracle }) => `'${oracle}'`).join(",");
  console.log(`ORACLE_ADDRESSES=${oracleAddresses}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
