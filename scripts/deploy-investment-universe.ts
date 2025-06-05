import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

  async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying Investment Universe with:", deployer.address);

    const underlyingAssetAddress = process.env.UNDERLYING_ASSET;
    if (!underlyingAssetAddress) {
        throw new Error("Please set UNDERLYING_ASSET in your .env file");
      }
    console.log("Using underlyingAsset at:", underlyingAssetAddress);

    const VaultFactory = await ethers.getContractFactory("UniverseERC4626Vault");

    const vaults = [];

    for (let i = 0; i < 2; i++) {
        const name = `Vault Token ${i}`;
        const symbol = `VT${i}`;

        const vault = await VaultFactory.deploy(underlyingAssetAddress, name, symbol);
        await vault.deployed();

        console.log(`Vault ${i} deployed to: ${vault.address}`);
        vaults.push(vault.address);
    }

    console.log("All vaults deployed:", vaults);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
