import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const mockUSDCAddress = process.env.UNDERLYING_ASSET;
  if (!mockUSDCAddress) {
    throw new Error("Please set UNDERLYING_ASSET in your .env file");
  }

  const [deployer, lp] = await ethers.getSigners();

  // Attach to the deployed MockUSDC contract
  const mockUSDC = await ethers.getContractAt("MockUSDC", mockUSDCAddress);

  const amount = ethers.utils.parseUnits("1000", 6);

  // Mint USDC to LP address, only deployer can mint
  const tx = await mockUSDC.connect(deployer).mint(await lp.getAddress(), amount);
  await tx.wait();

  console.log(`✅ Minted ${amount.toString()} MockUSDC to LP (${await lp.getAddress()})`);
}

main().catch((error) => {
  console.error("❌ Minting failed:", error);
  process.exitCode = 1;
});
