import { ethers } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS;
  if (!vaultAddress) throw new Error("Please set VAULT_ADDRESS in your .env file");

  const encryptedValueHex = process.env.ENCRYPTED_VALUE_HEX;
  if (!encryptedValueHex) throw new Error("Please set ENCRYPTED_VALUE_HEX in your .env file");

  const curatorPrivateKey = process.env.CURATOR_PRIVATE_KEY;
  if (!curatorPrivateKey) throw new Error("Please set CURATOR_PRIVATE_KEY in your .env file");

  // Create a new signer from curator's private key
  const curatorWallet = new ethers.Wallet(curatorPrivateKey, ethers.provider);

  // Connect to vault with curator wallet
  const vault = await ethers.getContractAt("FHEIntentsERC4626Vault", vaultAddress, curatorWallet);

  // Submit encrypted order
  const tx = await vault.submitEncryptedOrder(encryptedValueHex);
  await tx.wait();

  console.log("✅ Encrypted order submitted!");
}

main().catch((error) => {
  console.error("❌ Submission failed:", error);
  process.exitCode = 1;
});
