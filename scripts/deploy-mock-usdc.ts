import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying MockUSDC with:", deployer.address);

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const mockUSDC = await MockUSDC.deploy();
  await mockUSDC.deployed();

  console.log("✅ MockUSDC deployed to:", mockUSDC.address);
}

main().catch((error) => {
  console.error("❌ MockUSDC deployment failed:", error);
  process.exitCode = 1;
});
