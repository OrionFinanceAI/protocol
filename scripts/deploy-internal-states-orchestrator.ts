import * as dotenv from "dotenv";
import { ethers } from "hardhat";

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying InternalStatesOrchestrator with:", await deployer.getAddress());

  const registryAddress = process.env.CHAINLINK_AUTOMATION_REGISTRY_ADDRESS;
  if (!registryAddress) {
    throw new Error("Please set CHAINLINK_AUTOMATION_REGISTRY_ADDRESS in your .env file");
  }
  console.log("Using Chainlink Automation Registry:", registryAddress);

  const configAddress = process.env.CONFIG_ADDRESS;
  if (!configAddress) {
    throw new Error("Please set CONFIG_ADDRESS in your .env file");
  }

  console.log("Using OrionConfig at:", configAddress);

  const InternalStatesOrchestrator = await ethers.getContractFactory("InternalStatesOrchestrator");
  const internalStatesOrchestrator = await InternalStatesOrchestrator.deploy(registryAddress, configAddress);

  await internalStatesOrchestrator.waitForDeployment();

  console.log("✅ InternalStatesOrchestrator deployed to:", internalStatesOrchestrator.target);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
