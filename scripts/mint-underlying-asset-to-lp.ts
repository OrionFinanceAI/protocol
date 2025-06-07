import * as dotenv from "dotenv";
import { ethers } from "hardhat";

dotenv.config();

async function main() {
  const UnderlyingAssetAddress = process.env.UNDERLYING_ASSET;
  if (!UnderlyingAssetAddress) {
    throw new Error("Please set UNDERLYING_ASSET in your .env file");
  }

  const [deployer, lp] = await ethers.getSigners();

  // Attach to the deployed UnderlyingAsset contract
  const UnderlyingAsset = await ethers.getContractAt("UnderlyingAsset", UnderlyingAssetAddress);

  // ethers v6 uses parseUnits same way but returns bigint
  const amount = ethers.parseUnits("100000", 6);

  // Mint USDC to LP address, only deployer can mint
  const tx = await UnderlyingAsset.connect(deployer).mint(await lp.getAddress(), amount);
  await tx.wait();

  console.log(`✅ Minted ${amount.toString()} UnderlyingAsset to LP (${await lp.getAddress()})`);
}

main().catch((error) => {
  console.error("❌ Minting failed:", error);
  process.exitCode = 1;
});
