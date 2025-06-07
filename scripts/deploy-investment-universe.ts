import * as dotenv from "dotenv";
import { ethers } from "hardhat";

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying Investment Universe with:", await deployer.getAddress());

  const UnderlyingAssetAddress = process.env.UNDERLYING_ASSET;
  if (!UnderlyingAssetAddress) {
    throw new Error("Please set UNDERLYING_ASSET in your .env file");
  }
  console.log("Using UnderlyingAsset at:", UnderlyingAssetAddress);

  const VaultFactory = await ethers.getContractFactory("UniverseERC4626Vault");

  const vaults: string[] = [];

  for (let i = 0; i < 2; i++) {
    const name = `Vault Token ${i}`;
    const symbol = `VT${i}`;

    const vault = await VaultFactory.deploy(UnderlyingAssetAddress, name, symbol);
    await vault.waitForDeployment();  // <-- updated here

    console.log(`Vault ${i} deployed to: ${vault.target}`);
    vaults.push(vault.target);
  }

  console.log("All vaults deployed:", vaults);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
