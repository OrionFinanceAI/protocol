import { ethers } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying Vault with:", deployer.address);

  const curatorAddress = process.env.CURATOR_ADDRESS;
  if (!curatorAddress) {
    throw new Error("Please set CURATOR_ADDRESS in your .env file");
  }
  console.log("Curator address:", curatorAddress);

  const fheContextPublicCID = process.env.FHE_CONTEXT_PUBLIC_CID;
  if (!fheContextPublicCID) {
    throw new Error("Please set FHE_CONTEXT_PUBLIC_CID in your .env file");
  }

  const mockUSDCAddress = process.env.MOCK_USDC_ADDRESS;
  if (!mockUSDCAddress) {
    throw new Error("Please set MOCK_USDC_ADDRESS in your .env file");
  }
  console.log("Using MockUSDC at:", mockUSDCAddress);

  const whitelistAddress = process.env.WHITELIST_ADDRESS;
  if (!whitelistAddress) {
    throw new Error("Please set WHITELIST_ADDRESS in your .env file");
  }
  console.log("Using Whitelist at:", whitelistAddress);

  const Vault = await ethers.getContractFactory("FHEIntentsERC4626Vault");
  const vault = await Vault.deploy(mockUSDCAddress, curatorAddress, fheContextPublicCID, whitelistAddress);
  await vault.deployed();

  console.log("✅ ERC4626 Vault deployed to:", vault.address);
}

main().catch((error) => {
  console.error("❌ Vault deployment failed:", error);
  process.exitCode = 1;
});
