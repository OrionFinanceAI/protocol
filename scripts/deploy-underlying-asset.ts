import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying MockUnderlyingAsset with:", await deployer.getAddress());

  const MockUnderlyingAsset = await ethers.getContractFactory("MockUnderlyingAsset");
  const MockUnderlyingAssetContract = await MockUnderlyingAsset.deploy();
  await MockUnderlyingAssetContract.waitForDeployment();

  console.log("✅ MockUnderlyingAsset deployed to:", await MockUnderlyingAssetContract.getAddress());
}

main().catch((error) => {
  console.error("❌ MockUnderlyingAsset deployment failed:", error);
  process.exitCode = 1;
});
