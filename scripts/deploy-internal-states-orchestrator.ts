import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying InternalStatesOrchestrator with:", deployer.address);

  const InternalStatesOrchestrator = await ethers.getContractFactory("InternalStatesOrchestrator");
  const internalStatesOrchestrator = await InternalStatesOrchestrator.deploy();
  await internalStatesOrchestrator.deployed();

  console.log("✅ InternalStatesOrchestrator deployed to:", internalStatesOrchestrator.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
