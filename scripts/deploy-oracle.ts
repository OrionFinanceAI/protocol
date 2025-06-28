import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying MarketOracle with:", await deployer.getAddress());

  const MarketOracle = await ethers.getContractFactory("MarketOracle");
  const marketOracle = await MarketOracle.deploy();

  await marketOracle.waitForDeployment();

  console.log("✅ MarketOracle deployed to:", marketOracle.target);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
