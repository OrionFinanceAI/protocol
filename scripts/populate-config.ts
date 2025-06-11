import * as dotenv from "dotenv";
import { ethers } from "hardhat";

dotenv.config();

function getUniverseList(): string[] {
  return [
    "0xfCC5b1522C59960C6D66671c7856E9376C371d7B",
    "0xc0AD3243a718C9b06F64A126215F8f3DCca847ac",
    "0xA32f688A23bc7a5EE8A0CC09edBa9f76fB1672aF",
    "0x4b604fdb292762466B156f9D3eA0Ae8337ae333e",
    "0x4956b52ae2ff65d74ca2d61207523288e4528f96"
  ];
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Using deployer:", await deployer.getAddress());

  const {
    CONFIG_ADDRESS,
    UNDERLYING_ASSET,
    INTERNAL_ORCHESTRATOR_ADDRESS,
    LIQUIDITY_ORCHESTRATOR_ADDRESS,
    ORACLE_ADDRESS,
    FHE_PUBLIC_CID,
    FACTORY_ADDRESS,
  } = process.env;

  if (
    !CONFIG_ADDRESS ||
    !UNDERLYING_ASSET ||
    !INTERNAL_ORCHESTRATOR_ADDRESS ||
    !LIQUIDITY_ORCHESTRATOR_ADDRESS ||
    !ORACLE_ADDRESS ||
    !FHE_PUBLIC_CID ||
    !FACTORY_ADDRESS
  ) {
    throw new Error("Missing one or more required env variables");
  }

  const config = await ethers.getContractAt("OrionConfig", CONFIG_ADDRESS);

  console.log("📦 Setting protocol parameters...");
  const setTx = await config.setProtocolParams(
    UNDERLYING_ASSET,
    INTERNAL_ORCHESTRATOR_ADDRESS,
    LIQUIDITY_ORCHESTRATOR_ADDRESS,
    ORACLE_ADDRESS,
    9, // Biggest integer that can be represented in 32 bits
    FHE_PUBLIC_CID,
  );
  await setTx.wait();
  console.log("✅ Protocol parameters updated");

  // console.log(`🏭 Setting vault factory address to ${FACTORY_ADDRESS}...`);
  // const factoryTx = await config.setVaultFactory(FACTORY_ADDRESS);
  // await factoryTx.wait();
  // console.log("✅ Vault factory address set");

  const universeList = getUniverseList();

  console.log(`🏭 Setting universe list to ${universeList.length} vaults...`);

  for (const vault of universeList) {
    const isAlreadyWhitelisted = await config.isWhitelisted(vault);
    if (!isAlreadyWhitelisted) {
      console.log(`Adding ${vault} to config whitelist...`);
      const tx = await config.addWhitelistedVault(vault);
      await tx.wait();
      console.log(`✅ Added ${vault} to config whitelist`);
    } else {
      console.log(`ℹ️  ${vault} is already in config whitelist.`);
    }
  }
}

main().catch((error) => {
  console.error("❌ Failed to add vaults:", error);
  process.exitCode = 1;
});
