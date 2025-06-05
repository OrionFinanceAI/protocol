import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying PriceAndPnLOracle with:", deployer.address);

  const PriceAndPnLOracle = await ethers.getContractFactory("PriceAndPnLOracle");
  const priceAndPnLOracle = await PriceAndPnLOracle.deploy();
  await priceAndPnLOracle.deployed();

  console.log("✅ PriceAndPnLOracle deployed to:", priceAndPnLOracle.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
