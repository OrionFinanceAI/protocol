import * as dotenv from "dotenv";
import { ethers } from "hardhat";

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying Investment Universe with:", await deployer.getAddress());

  const MockUnderlyingAssetAddress = process.env.UNDERLYING_ASSET;
  if (!MockUnderlyingAssetAddress) {
    throw new Error("Please set UNDERLYING_ASSET in your .env file");
  }
  console.log("Using MockUnderlyingAsset at:", MockUnderlyingAssetAddress);

  const VaultFactory = await ethers.getContractFactory("MockERC4626Asset");

  const vaults: string[] = [];

  for (let i = 0; i < 2; i++) {
    const name = `Vault Token ${i}`;
    const symbol = `VT${i}`;

    const vault = await VaultFactory.deploy(MockUnderlyingAssetAddress, name, symbol);
    await vault.waitForDeployment();

    console.log(`Vault ${i} deployed to: ${vault.target}`);
    vaults.push(vault.target);
  }

  console.log("All vaults deployed:", vaults);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
