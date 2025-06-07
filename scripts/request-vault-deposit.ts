import * as dotenv from "dotenv";
import { parseUnits } from "ethers";
import { ethers } from "hardhat";

dotenv.config();

async function main() {
  const [_, lp] = await ethers.getSigners();
  console.log("Using LP address:", lp.address);

  const vaultAddress = process.env.ORION_VAULT_ADDRESS;
  if (!vaultAddress) throw new Error("Missing ORION_VAULT_ADDRESS in .env");

  const UnderlyingAssetAddress = process.env.UNDERLYING_ASSET;
  if (!UnderlyingAssetAddress) {
    throw new Error("Please set UNDERLYING_ASSET in your .env file");
  }

  const depositAmount = parseUnits("1000", 6);

  const OrionVault = await ethers.getContractFactory("OrionVault");
  const vault = OrionVault.attach(vaultAddress);
  const iface = OrionVault.interface;

  const ERC20 = await ethers.getContractAt("IERC20", UnderlyingAssetAddress);
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

  // Manually parse logs using the OrionVault interface
  const parsedEvent = receipt.logs
    .map((log) => {
      try {
        return iface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "DepositRequested");

  if (!parsedEvent) {
    throw new Error("DepositRequested event not found");
  }

  const requestId = parsedEvent.args.requestId;
  console.log(`✅ Deposit request submitted (id: ${requestId.toString()})`);
}

main().catch((error) => {
  console.error("❌ Deposit request failed:", error);
  process.exitCode = 1;
});
