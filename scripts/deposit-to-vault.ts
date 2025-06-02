import { ethers } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const [_, lp] = await ethers.getSigners();

  const mockUSDCAddress = process.env.MOCK_USDC_ADDRESS!;
  const vaultAddress = process.env.VAULT_ADDRESS!;

  if (!mockUSDCAddress || !vaultAddress) {
    throw new Error("Please set MOCK_USDC_ADDRESS and VAULT_ADDRESS in your .env file");
  }

  const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
  const mockUSDC = MockUSDCFactory.attach(mockUSDCAddress).connect(lp);

  const VaultFactory = await ethers.getContractFactory("FHEIntentsERC4626Vault");
  const vault = VaultFactory.attach(vaultAddress).connect(lp);

  const amount = ethers.utils.parseUnits("100", 6);

  let usdcBalance = await mockUSDC.balanceOf(await lp.getAddress());
  let vaultTokenBalance = await vault.balanceOf(await lp.getAddress());

  const approveTx = await mockUSDC.approve(vaultAddress, amount);
  await approveTx.wait();
  
  const depositTx = await vault.deposit(amount, await lp.getAddress());
  await depositTx.wait();
  console.log("Deposit successful.");

  usdcBalance = await mockUSDC.balanceOf(await lp.getAddress());
  vaultTokenBalance = await vault.balanceOf(await lp.getAddress());
  console.log(`LP USDC balance after deposit: ${usdcBalance.toString()}`);
  console.log(`LP Vault token balance after deposit: ${vaultTokenBalance.toString()}`);
}

main().catch((error) => {
  console.error("Error during interaction:", error);
  process.exitCode = 1;
});
