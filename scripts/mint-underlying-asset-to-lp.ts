import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const underlyingAssetAddress = process.env.UNDERLYING_ASSET;
  if (!underlyingAssetAddress) {
    throw new Error("Please set UNDERLYING_ASSET in your .env file");
  }

  const [deployer, lp] = await ethers.getSigners();

  // Attach to the deployed underlyingAsset contract
  const underlyingAsset = await ethers.getContractAt("underlyingAsset", underlyingAssetAddress);

  const amount = ethers.utils.parseUnits("100000", 6);

  // Mint USDC to LP address, only deployer can mint
  const tx = await underlyingAsset.connect(deployer).mint(await lp.getAddress(), amount);
  await tx.wait();

  console.log(`✅ Minted ${amount.toString()} underlyingAsset to LP (${await lp.getAddress()})`);
}

main().catch((error) => {
  console.error("❌ Minting failed:", error);
  process.exitCode = 1;
});
