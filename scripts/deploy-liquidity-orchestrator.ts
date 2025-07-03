import { ethers, network, upgrades } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying LiquidityOrchestrator with:", await deployer.getAddress());
  console.log("Network:", network.name);

  const LiquidityOrchestrator = await ethers.getContractFactory("LiquidityOrchestrator");
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");

  let liquidityOrchestratorProxy;

  if (network.name === "localhost" || network.name === "hardhat") {
    console.log("Deploying implementation...");
    const implementation = await LiquidityOrchestrator.deploy();
    await implementation.waitForDeployment();
    const implementationAddress = await implementation.getAddress();
    console.log("Implementation deployed at:", implementationAddress);

    console.log("Deploying proxy...");
    const initData = LiquidityOrchestrator.interface.encodeFunctionData("initialize", [deployer.address]);
    const proxy = await ERC1967Proxy.deploy(implementationAddress, initData);
    await proxy.waitForDeployment();

    liquidityOrchestratorProxy = await ethers.getContractAt("LiquidityOrchestrator", await proxy.getAddress());
  } else {
    liquidityOrchestratorProxy = await upgrades.deployProxy(LiquidityOrchestrator, [deployer.address], {
      initializer: "initialize",
    });
    await liquidityOrchestratorProxy.waitForDeployment();
  }

  const liquidityOrchestratorAddress = await liquidityOrchestratorProxy.getAddress();
  console.log("✅ LiquidityOrchestrator deployed to:", liquidityOrchestratorAddress);

  // Ownership check
  const owner = await liquidityOrchestratorProxy.owner();
  console.log("LiquidityOrchestrator owner:", owner);
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`❌ Owner mismatch. Expected ${deployer.address}, got ${owner}`);
  }
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
