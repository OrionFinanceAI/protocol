import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying OrionVaultFactory with:", deployer.address);

  const configAddress = process.env.CONFIG_ADDRESS;
  if (!configAddress) {
    throw new Error("Please set CONFIG_ADDRESS in your .env file");
  }

  console.log("Using OrionConfig at:", configAddress);

  // Deploy the OrionVaultFactory
  const OrionVaultFactory = await ethers.getContractFactory("OrionVaultFactory");
  const factory = await OrionVaultFactory.deploy(configAddress);
  await factory.deployed();

  console.log("OrionVaultFactory deployed to:", factory.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
