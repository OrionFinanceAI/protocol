import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying InternalStatesOrchestrator with:", await deployer.getAddress());

  const InternalStatesOrchestrator = await ethers.getContractFactory("InternalStatesOrchestrator");
  const internalStatesOrchestrator = await InternalStatesOrchestrator.deploy();

  await internalStatesOrchestrator.waitForDeployment();

  console.log("✅ InternalStatesOrchestrator deployed to:", internalStatesOrchestrator.target);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
