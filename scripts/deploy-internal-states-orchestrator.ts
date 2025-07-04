import * as dotenv from "dotenv";
import { ethers, network, upgrades } from "hardhat";

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying InternalStatesOrchestrator with:", await deployer.getAddress());
  console.log("Network:", network.name);

  const registryAddress = process.env.CHAINLINK_AUTOMATION_REGISTRY_ADDRESS;
  if (!registryAddress) {
    throw new Error("Please set CHAINLINK_AUTOMATION_REGISTRY_ADDRESS in your .env file");
  }
  console.log("Using Chainlink Automation Registry:", registryAddress);

  const configAddress = process.env.CONFIG_ADDRESS;
  if (!configAddress) {
    throw new Error("Please set CONFIG_ADDRESS in your .env file");
  }
  console.log("Using OrionConfig at:", configAddress);

  const InternalStatesOrchestrator = await ethers.getContractFactory("InternalStatesOrchestrator");

  let internalStatesOrchestratorProxy;

  if (network.name === "localhost" || network.name === "hardhat") {
    // For local development, deploy implementation and proxy separately
    console.log("Deploying implementation...");
    const implementation = await InternalStatesOrchestrator.deploy();
    await implementation.waitForDeployment();
    const implementationAddress = await implementation.getAddress();
    console.log("Implementation deployed at:", implementationAddress);

    // Deploy proxy
    console.log("Deploying proxy...");
    const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const initData = InternalStatesOrchestrator.interface.encodeFunctionData("initialize", [
      deployer.address,
      registryAddress,
      configAddress,
    ]);
    const proxy = await ERC1967Proxy.deploy(implementationAddress, initData);
    await proxy.waitForDeployment();
    internalStatesOrchestratorProxy = await ethers.getContractAt(
      "InternalStatesOrchestrator",
      await proxy.getAddress(),
    );
  } else {
    // For production, use the upgrades plugin
    internalStatesOrchestratorProxy = await upgrades.deployProxy(
      InternalStatesOrchestrator,
      [deployer.address, registryAddress, configAddress],
      { initializer: "initialize" },
    );
    await internalStatesOrchestratorProxy.waitForDeployment();
  }

  console.log("✅ InternalStatesOrchestrator deployed to:", await internalStatesOrchestratorProxy.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
