import * as dotenv from "dotenv";
import { ethers } from "hardhat";

dotenv.config();

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Using deployer:", signer.address);

  const factoryAddress = process.env.FACTORY_ADDRESS;
  const curatorAddress = process.env.CURATOR_ADDRESS;

  if (!factoryAddress) throw new Error("Missing FACTORY_ADDRESS in .env");
  if (!curatorAddress) throw new Error("Missing CURATOR_ADDRESS in .env");

  const OrionVaultFactory = await ethers.getContractFactory("OrionVaultFactory");
  const factory = OrionVaultFactory.attach(factoryAddress);

  console.log("Creating OrionVault for curator:", curatorAddress);

  const tx = await factory.createOrionVault(curatorAddress);
  const receipt = await tx.wait();

  const event = receipt.events?.find((e: any) => e.event === "OrionVaultCreated");

  if (!event) {
    throw new Error("OrionVaultCreated event not found in tx receipt");
  }

  const vaultAddress = event?.args?.vault;
  console.log("✅ OrionVault deployed at:", vaultAddress);
}

main().catch((error) => {
  console.error("❌ Deployment failed:", error);
  process.exitCode = 1;
});
