import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying OrionConfig with:", deployer.address);

  const Config = await ethers.getContractFactory("OrionConfig");
  const config = await Config.deploy();

  await config.deployed();

  console.log("✅ OrionConfig deployed to:", config.address);
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
