import { ethers } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying OrionConfig with:", deployer.address);

  const fhePublicCID = process.env.FHE_PUBLIC_CID;
  if (!fhePublicCID) {
    throw new Error("❌ FHE_PUBLIC_CID is not defined in .env");
  }

  const Config = await ethers.getContractFactory("OrionConfig");
  const config = await Config.deploy(fhePublicCID);

  await config.deployed();

  console.log("✅ OrionConfig deployed to:", config.address);
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
