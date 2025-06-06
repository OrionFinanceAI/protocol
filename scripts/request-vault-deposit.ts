import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const [_, lp] = await ethers.getSigners();
  console.log("Using LP address:", lp.address);

  const vaultAddress = process.env.ORION_VAULT_ADDRESS;
  if (!vaultAddress) throw new Error("Missing ORION_VAULT_ADDRESS in .env");

  const underlyingAssetAddress = process.env.UNDERLYING_ASSET;
  if (!underlyingAssetAddress) {
    throw new Error("Please set UNDERLYING_ASSET in your .env file");
  }

  const depositAmount = ethers.utils.parseUnits("1000", 6);

  const OrionVault = await ethers.getContractFactory("OrionVault");
  const vault = OrionVault.attach(vaultAddress);

  const ERC20 = await ethers.getContractAt("IERC20", underlyingAssetAddress);

  const lpAddress = await lp.getAddress();
  const balance = await ERC20.balanceOf(lpAddress);

  console.log(`LP balance: ${balance}`);

  // Approve vault to spend underlying asset tokens from LP
  const approveTx = await ERC20.connect(lp).approve(vaultAddress, depositAmount);
  await approveTx.wait();
  console.log(`✅ Approved ${depositAmount} underlying tokens to OrionVault`);
  
  // Connect LP signer to vault and request deposit
  const tx = await vault.connect(lp).requestDeposit(depositAmount);

  const receipt = await tx.wait();

  const event = receipt.events?.find((e: any) => e.event === "DepositRequested");

  if (!event) {
    throw new Error("DepositRequested event not found");
  }

  const requestId = event.args?.requestId;
  console.log(`✅ Deposit request submitted (id: ${requestId.toString()})`);
}

main().catch((error) => {
  console.error("❌ Deposit request failed:", error);
  process.exitCode = 1;
});
