import hre from "hardhat";

// TODO: generalize this process to also advance the price of whitelisted assets for end to end testing.
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
