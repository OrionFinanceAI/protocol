import { ethers } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with:", deployer.address);

  const curatorAddress = process.env.CURATOR_ADDRESS;
  if (!curatorAddress) {
    throw new Error("Please set CURATOR_ADDRESS in your .env file");
  }
  console.log("Curator address:", curatorAddress);

  const fhePublicKeyHex = process.env.FHE_PUBLIC_KEY;
  if (!fhePublicKeyHex) {
    throw new Error("Please set FHE_PUBLIC_KEY in your .env file");
  }

  // This is the critical line:
  const fhePublicKeyBytes = ethers.utils.arrayify(fhePublicKeyHex);

  // Deploy MockUSDC
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const mockUSDC = await MockUSDC.deploy();
  await mockUSDC.deployed();
  console.log("✅ MockUSDC deployed to:", mockUSDC.address);

  // Deploy Vault
  const Vault = await ethers.getContractFactory("FHEIntentsERC4626Vault");
  const vault = await Vault.deploy(mockUSDC.address, curatorAddress, fhePublicKeyBytes);
  await vault.deployed();
  console.log("✅ ERC4626 Vault deployed to:", vault.address);
}

main().catch((error) => {
  console.error("❌ Deployment failed:", error);
  process.exitCode = 1;
});
