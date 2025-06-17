const { ethers, upgrades, network } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying OrionConfig with:", await deployer.getAddress());
  console.log("Network:", network.name);

  const OrionConfig = await ethers.getContractFactory("OrionConfig");
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");

  let configProxy;

  // Check if we're on a local network (like Anvil)
  if (network.name === "localhost" || network.name === "hardhat") {
    // For local development, deploy implementation and proxy separately
    console.log("Deploying implementation...");
    const implementation = await OrionConfig.deploy();
    await implementation.waitForDeployment();
    const implementationAddress = await implementation.getAddress();
    console.log("Implementation deployed at:", implementationAddress);

    // Deploy proxy with initialization
    console.log("Deploying proxy...");
    const initData = OrionConfig.interface.encodeFunctionData("initialize", [deployer.address]);
    const proxy = await ERC1967Proxy.deploy(implementationAddress, initData);
    await proxy.waitForDeployment();
    configProxy = await ethers.getContractAt("OrionConfig", await proxy.getAddress());
  } else {
    // For production, use the upgrades plugin
    configProxy = await upgrades.deployProxy(OrionConfig, [deployer.address], {
      initializer: "initialize",
    });
    await configProxy.waitForDeployment();
  }

  const configAddress = await configProxy.getAddress();
  console.log("✅ OrionConfig deployed to:", configAddress);

  // Verify the owner was set correctly
  const owner = await configProxy.owner();
  console.log("Config owner:", owner);
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Owner not set correctly. Expected ${deployer.address} but got ${owner}`);
  }
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
