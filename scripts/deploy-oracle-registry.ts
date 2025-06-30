import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying OracleRegistry with:", await deployer.getAddress());

  const OracleRegistry = await ethers.getContractFactory("OracleRegistry");
  const oracleRegistry = await OracleRegistry.deploy();

  await oracleRegistry.waitForDeployment();

  console.log("✅ OracleRegistry deployed to:", oracleRegistry.target);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
