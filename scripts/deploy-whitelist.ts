import { ethers } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying UniverseERC4626Whitelist with:", deployer.address);

  const Whitelist = await ethers.getContractFactory("UniverseERC4626Whitelist");
  const whitelist = await Whitelist.deploy();

  await whitelist.deployed();

  console.log("✅ UniverseERC4626Whitelist deployed to:", whitelist.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
