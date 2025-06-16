import * as dotenv from "dotenv";

const { ethers, upgrades } = require("hardhat");

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

  const internalStatesOrchestratorProxy = await upgrades.deployProxy(
    InternalStatesOrchestrator,
    [deployer.address, registryAddress, configAddress],
    { initializer: "initialize" },
  );

  await internalStatesOrchestratorProxy.waitForDeployment();

  console.log("✅ InternalStatesOrchestrator deployed to:", await internalStatesOrchestratorProxy.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
