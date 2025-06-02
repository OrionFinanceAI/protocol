import { ethers } from "hardhat";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying Investment Universe with:", deployer.address);

    const mockUSDCAddress = process.env.MOCK_USDC_ADDRESS;
    if (!mockUSDCAddress) {
        throw new Error("Please set MOCK_USDC_ADDRESS in your .env file");
      }
    console.log("Using MockUSDC at:", mockUSDCAddress);

    const VaultFactory = await ethers.getContractFactory("UniverseERC4626Vault");

    const vaults = [];

    for (let i = 0; i < 2; i++) {
        const name = `Vault Token ${i}`;
        const symbol = `VT${i}`;

        const vault = await VaultFactory.deploy(mockUSDCAddress, name, symbol);
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
