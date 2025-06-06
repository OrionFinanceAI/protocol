import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const [_, lp] = await ethers.getSigners();
  console.log("Using LP address:", lp.address);

  const vaultAddress = process.env.ORION_VAULT_ADDRESS;
  if (!vaultAddress) throw new Error("Missing ORION_VAULT_ADDRESS in .env");

  const OrionVault = await ethers.getContractFactory("OrionVault");
  const vault = OrionVault.attach(vaultAddress);
  const shareDecimals = await vault.decimals();

  const withdrawShares = ethers.utils.parseUnits("1000", shareDecimals);

  // Check LP's current share balance
  const lpAddress = await lp.getAddress();
  const shareBalance = await vault.balanceOf(lpAddress);
  console.log(`LP share balance: ${shareBalance}`);

  if (shareBalance.lt(withdrawShares)) {
    throw new Error("❌ Not enough shares to withdraw the requested amount");
  }

  // Submit the withdrawal request
  const tx = await vault.connect(lp).requestWithdraw(withdrawShares);
  const receipt = await tx.wait();

  const event = receipt.events?.find((e: any) => e.event === "WithdrawRequested");

  if (!event) {
    throw new Error("WithdrawRequested event not found");
  }

  const requestId = event.args?.[2]; // withdrawRequests.length - 1
  console.log(`✅ Withdrawal request submitted (id: ${requestId.toString()})`);
}

main().catch((error) => {
  console.error("❌ Withdrawal request failed:", error);
  process.exitCode = 1;
});
