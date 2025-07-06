import * as dotenv from "dotenv";
import { ethers } from "hardhat";

dotenv.config();

async function main() {
  const MockUnderlyingAssetAddress = process.env.UNDERLYING_ASSET;
  if (!MockUnderlyingAssetAddress) {
    throw new Error("Please set UNDERLYING_ASSET in your .env file");
  }

  const [deployer, lp] = await ethers.getSigners();

  // Attach to the deployed MockUnderlyingAsset contract
  const MockUnderlyingAsset = await ethers.getContractAt("MockUnderlyingAsset", MockUnderlyingAssetAddress);

  // ethers v6 uses parseUnits same way but returns bigint
  const amount = ethers.parseUnits("100000", 6);

  // Mint USDC to LP address, only deployer can mint
  const tx = await MockUnderlyingAsset.connect(deployer).mint(await lp.getAddress(), amount);
  await tx.wait();

  console.log(`✅ Minted ${amount.toString()} MockUnderlyingAsset to LP (${await lp.getAddress()})`);
}

main().catch((error) => {
  console.error("❌ Minting failed:", error);
  process.exitCode = 1;
});
