import hre from "hardhat";

async function advanceTime() {
  try {
    await hre.network.provider.send("evm_increaseTime", [100]);
    await hre.network.provider.send("evm_mine");

    console.log(`Advanced time by 100 seconds at ${new Date().toISOString()}`);
  } catch (error) {
    console.error("Error advancing time:", error);
  }
}

setInterval(() => {
  advanceTime();
}, 5000);

advanceTime();
