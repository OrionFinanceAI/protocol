import * as dotenv from "dotenv";
import { ethers, upgrades } from "hardhat";

dotenv.config();

async function main() {
  const OrionConfig = await ethers.getContractFactory("OrionConfig");

  try {
    await upgrades.validateUpgrade(process.env.CONFIG_ADDRESS!, OrionConfig);
    console.log(`✓ OrionConfig upgrade is safe`);
  } catch (error: any) {
    console.log(`✗ OrionConfig upgrade validation failed:`, error.message);
    process.exitCode = 1;
  }

  const upgradedConfig = await upgrades.upgradeProxy(process.env.CONFIG_ADDRESS!, OrionConfig);
  console.log("OrionConfig upgraded successfully");
  console.log("Proxy address (unchanged):", await upgradedConfig.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
