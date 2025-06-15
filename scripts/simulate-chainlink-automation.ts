import * as dotenv from "dotenv";
import { ethers } from "hardhat";

dotenv.config();

async function main() {
  const internalStatesOrchestratorAddress = process.env.INTERNAL_ORCHESTRATOR_ADDRESS;
  if (!internalStatesOrchestratorAddress) {
    throw new Error("INTERNAL_ORCHESTRATOR_ADDRESS environment variable is required");
  }

  const InternalStatesOrchestrator = await ethers.getContractFactory("InternalStatesOrchestrator");
  const orchestrator = InternalStatesOrchestrator.attach(internalStatesOrchestratorAddress);

  const [upkeepNeeded, performData]: [boolean, string] = await orchestrator.checkUpkeep("0x");

  console.log("Upkeep needed?", upkeepNeeded);

  if (upkeepNeeded) {
    console.log("Performing upkeep...");

    const [deployer] = await ethers.getSigners();
    console.log("Using deployer address:", await deployer.getAddress());

    // Impersonate Chainlink Registry on Hardhat network
    const registryAddress = await orchestrator.registry();

    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [registryAddress],
    });

    const registrySigner = await ethers.getSigner(registryAddress);

    // Send performUpkeep tx from impersonated registry address
    const tx = await orchestrator.connect(registrySigner).performUpkeep(performData);
    await tx.wait();

    console.log("Upkeep performed!");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
