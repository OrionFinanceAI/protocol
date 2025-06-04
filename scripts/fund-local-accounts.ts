import { network, ethers } from "hardhat";

// List of addresses to fund
const addresses = [
  "0x94b971A1c73d10b12E0010ab1327C40aB5bCd330",
  "0xde1F4FeE2886fF17294DCC3fE13033A4dB9B6545",
  "0xB86aff7C3dfE0694453F90F0Db8FDF9b93528BA2",
];

// Amount to fund in ETH
const amountInEth = "1000";

async function main() {
  if (network.name !== "localhost") {
    throw new Error("⚠️  This script should only be run on the localhost network.");
  }

  const amount = ethers.utils.parseEther(amountInEth);

  for (const address of addresses) {
    console.log(`⛽ Funding ${address} with ${amountInEth} ETH`);

    // Set balance using hardhat_setBalance
    await network.provider.send("hardhat_setBalance", [
      address,
      amount.toHexString(),
    ]);
  }

  console.log("✅ All addresses funded.");
}

main().catch((error) => {
  console.error("❌ Funding failed:", error);
  process.exitCode = 1;
});
