import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying OrionConfig with:", await deployer.getAddress());

  const Config = await ethers.getContractFactory("OrionConfig");
  const config = await Config.deploy();

  await config.waitForDeployment(); // updated here

  console.log("✅ OrionConfig deployed to:", config.target);
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
