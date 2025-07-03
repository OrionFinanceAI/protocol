import * as dotenv from "dotenv";
import { ethers, network } from "hardhat";
import { upgrades } from "hardhat";

import { OrionVaultFactory } from "../typechain-types";

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  console.log("Deploying OrionVaultFactory with:", deployerAddress);
  console.log("Network:", network.name);

  const configAddress = process.env.CONFIG_ADDRESS;
  if (!configAddress) {
    throw new Error("Please set CONFIG_ADDRESS in your .env file");
  }

  console.log("Using OrionConfig at:", configAddress);
  const OrionVaultFactory = await ethers.getContractFactory("OrionVaultFactory");

  let factoryProxy;

  if (network.name === "localhost" || network.name === "hardhat") {
    // For local development with Anvil, deploy implementation and proxy separately
    console.log("Deploying implementation...");
    const implementation = await OrionVaultFactory.deploy([deployerAddress, configAddress]);
    await implementation.waitForDeployment();
    const implementationAddress = await implementation.getAddress();
    console.log("Implementation deployed at:", implementationAddress);

    // Deploy proxy
    console.log("Deploying proxy...");
    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const initData = OrionVaultFactory.interface.encodeFunctionData("initialize", [deployerAddress, configAddress]);
    const proxy = await ERC1967Proxy.deploy(implementationAddress, initData);
    await proxy.waitForDeployment();
    factoryProxy = await ethers.getContractAt("OrionVaultFactory", await proxy.getAddress());
  } else {
    // For production, use the upgrades plugin
    factoryProxy = await upgrades.deployProxy(OrionVaultFactory, [deployerAddress, configAddress], {
      initializer: "initialize",
    });
    await factoryProxy.waitForDeployment();
  }

  // Set the vault implementations
  const vaultImplementationsAddress = process.env.VAULT_IMPLEMENTATIONS_ADDRESS;
  if (!vaultImplementationsAddress) {
    throw new Error("Please set VAULT_IMPLEMENTATIONS_ADDRESS in your .env file");
  }

  console.log("Using VaultImplementations at:", vaultImplementationsAddress);
  const VaultImplementations = await ethers.getContractAt("VaultImplementations", vaultImplementationsAddress);
  const transparentImpl = await VaultImplementations.TRANSPARENT_VAULT_IMPLEMENTATION();
  const encryptedImpl = await VaultImplementations.ENCRYPTED_VAULT_IMPLEMENTATION();
  console.log("Using TransparentVault at:", transparentImpl);
  console.log("Using EncryptedVault at:", encryptedImpl);

  console.log("Setting vault implementations...");

  // Get the factory contract with the deployer as the signer
  const factory = (await ethers.getContractAt(
    "OrionVaultFactory",
    await factoryProxy.getAddress(),
  )) as unknown as OrionVaultFactory;

  // Verify the owner
  const owner = await factory.owner();
  console.log("Current owner:", owner);
  console.log("Deployer address:", deployerAddress);

  if (owner.toLowerCase() !== deployerAddress.toLowerCase()) {
    throw new Error(`Owner mismatch. Expected ${deployerAddress} but got ${owner}`);
  }

  // Set implementations using the deployer account
  const tx = await factory.setImplementations(transparentImpl, encryptedImpl);
  await tx.wait();
  console.log("✅ Vault implementations set");

  console.log("✅ OrionVaultFactory deployed to:", await factoryProxy.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
