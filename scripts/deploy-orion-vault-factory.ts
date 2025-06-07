import * as dotenv from "dotenv";
import { ethers } from "hardhat";

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying OrionVaultFactory with:", await deployer.getAddress());

  const configAddress = process.env.CONFIG_ADDRESS;
  if (!configAddress) {
    throw new Error("Please set CONFIG_ADDRESS in your .env file");
  }

  console.log("Using OrionConfig at:", configAddress);

  const OrionVaultFactory = await ethers.getContractFactory("OrionVaultFactory");
  const factory = await OrionVaultFactory.deploy(configAddress);
  await factory.waitForDeployment();

  console.log("OrionVaultFactory deployed to:", factory.target);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
