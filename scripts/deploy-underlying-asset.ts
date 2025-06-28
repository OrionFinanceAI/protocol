import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying UnderlyingAsset with:", await deployer.getAddress());

  const UnderlyingAsset = await ethers.getContractFactory("UnderlyingAsset");
  const UnderlyingAssetContract = await UnderlyingAsset.deploy();
  await UnderlyingAssetContract.waitForDeployment();

  console.log("✅ UnderlyingAsset deployed to:", await UnderlyingAssetContract.getAddress());
}

main().catch((error) => {
  console.error("❌ UnderlyingAsset deployment failed:", error);
  process.exitCode = 1;
});
