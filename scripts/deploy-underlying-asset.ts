import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying underlyingAsset with:", deployer.address);

  const underlyingAsset = await ethers.getContractFactory("underlyingAsset");
  const underlyingAssetContract = await underlyingAsset.deploy();
  await underlyingAssetContract.deployed();

  console.log("✅ underlyingAsset deployed to:", underlyingAssetContract.address);
}

main().catch((error) => {
  console.error("❌ underlyingAsset deployment failed:", error);
  process.exitCode = 1;
});
