import * as dotenv from "dotenv";
import { ethers } from "hardhat";

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying VaultImplementations with:", await deployer.getAddress());

  const VaultImplementations = await ethers.getContractFactory("VaultImplementations");

  const vaultImplementations = await VaultImplementations.deploy();

  await vaultImplementations.waitForDeployment();

  const deployedAddress = await vaultImplementations.getAddress();
  console.log("✅ VaultImplementations deployed to:", deployedAddress);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
