import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying PriceAndPnLOracle with:", await deployer.getAddress());

  const PriceAndPnLOracle = await ethers.getContractFactory("PriceAndPnLOracle");
  const priceAndPnLOracle = await PriceAndPnLOracle.deploy();

  await priceAndPnLOracle.waitForDeployment();

  console.log("✅ PriceAndPnLOracle deployed to:", priceAndPnLOracle.target);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
