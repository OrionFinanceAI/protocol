import * as dotenv from "dotenv";
import { ethers } from "hardhat";
import { upgrades } from "hardhat";

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying OrionVaultFactory with:", await deployer.getAddress());

  const configAddress = process.env.CONFIG_ADDRESS;
  if (!configAddress) {
    throw new Error("Please set CONFIG_ADDRESS in your .env file");
  }

  console.log("Using OrionConfig at:", configAddress);
  const OrionVaultFactory = await ethers.getContractFactory("OrionVaultFactory");

  const factoryProxy = await upgrades.deployProxy(OrionVaultFactory, [deployer.address, configAddress], {
    initializer: "initialize",
  });

  await factoryProxy.waitForDeployment();

  // Set the vault implementations
  const vaultImplementationsAddress = process.env.VAULT_IMPLEMENTATIONS_ADDRESS;
  if (!vaultImplementationsAddress) {
    throw new Error("Please set VAULT_IMPLEMENTATIONS_ADDRESS in your .env file");
  }

  console.log("Using VaultImplementations at:", vaultImplementationsAddress);
  const VaultImplementations = await ethers.getContractAt("VaultImplementations", vaultImplementationsAddress);
  const transparentImpl = await VaultImplementations.transparentVaultImplementation();
  const encryptedImpl = await VaultImplementations.encryptedVaultImplementation();
  console.log("Using TransparentVault at:", transparentImpl);
  console.log("Using EncryptedVault at:", encryptedImpl);

  console.log("Setting vault implementations...");

  await factoryProxy.setImplementations(transparentImpl, encryptedImpl);
  console.log("✅ Vault implementations set");

  console.log("✅ OrionVaultFactory deployed to:", await factoryProxy.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
