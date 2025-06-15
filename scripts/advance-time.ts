import hre from "hardhat";

async function advanceTime() {
  try {
    await hre.network.provider.send("evm_increaseTime", [5]);
    await hre.network.provider.send("evm_mine");

    console.log(`Advanced time by 5 seconds at ${new Date().toISOString()}`);
  } catch (error) {
    console.error("Error advancing time:", error);
  }
}

setInterval(() => {
  advanceTime();
}, 5000);

advanceTime();
