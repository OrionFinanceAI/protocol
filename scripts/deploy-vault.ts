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

  const fhePublicKeyCID = process.env.FHE_PUBLIC_KEY_CID;
  if (!fhePublicKeyCID) {
    throw new Error("Please set FHE_PUBLIC_KEY_CID in your .env file");
  }

  const mockUSDCAddress = process.env.MOCK_USDC_ADDRESS;
  if (!mockUSDCAddress) {
    throw new Error("Please set MOCK_USDC_ADDRESS in your .env file");
  }
  console.log("Using MockUSDC at:", mockUSDCAddress);

  const Vault = await ethers.getContractFactory("FHEIntentsERC4626Vault");
  const vault = await Vault.deploy(mockUSDCAddress, curatorAddress, fhePublicKeyCID);
  await vault.deployed();

  console.log("✅ ERC4626 Vault deployed to:", vault.address);
  console.log("🔗 FHE Key IPFS CID stored in contract:", fhePublicKeyCID);
}

main().catch((error) => {
  console.error("❌ Vault deployment failed:", error);
  process.exitCode = 1;
});
