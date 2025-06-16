const { ethers, upgrades } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying OrionConfig with:", await deployer.getAddress());

  const OrionConfig = await ethers.getContractFactory("OrionConfig");

  const configProxy = await upgrades.deployProxy(OrionConfig, [deployer.address], { initializer: "initialize" });

  await configProxy.waitForDeployment();

  console.log("✅ OrionConfig deployed to:", await configProxy.getAddress());
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
