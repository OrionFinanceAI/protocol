import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying LiquidityOrchestrator with:", await deployer.getAddress());

  const LiquidityOrchestrator = await ethers.getContractFactory("LiquidityOrchestrator");
  const liquidityOrchestrator = await LiquidityOrchestrator.deploy();

  await liquidityOrchestrator.waitForDeployment();

  console.log("✅ LiquidityOrchestrator deployed to:", liquidityOrchestrator.target);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
