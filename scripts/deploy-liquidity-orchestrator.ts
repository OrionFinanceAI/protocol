import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying LiquidityOrchestrator with:", deployer.address);

  const LiquidityOrchestrator = await ethers.getContractFactory("LiquidityOrchestrator");
  const liquidityOrchestrator = await LiquidityOrchestrator.deploy();
  await liquidityOrchestrator.deployed();

  console.log("✅ LiquidityOrchestrator deployed to:", liquidityOrchestrator.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
