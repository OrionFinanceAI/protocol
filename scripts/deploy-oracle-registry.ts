import { ethers, network, upgrades } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying OracleRegistry with:", await deployer.getAddress());
  console.log("Network:", network.name);

  const OracleRegistry = await ethers.getContractFactory("OracleRegistry");
  const ERC1967Proxy = await ethers.getContractFactory("ERC1967Proxy");

  let registryProxy;

  if (network.name === "localhost" || network.name === "hardhat") {
    console.log("Deploying implementation...");
    const implementation = await OracleRegistry.deploy();
    await implementation.waitForDeployment();
    const implementationAddress = await implementation.getAddress();
    console.log("Implementation deployed at:", implementationAddress);

    console.log("Deploying proxy...");
    const initData = OracleRegistry.interface.encodeFunctionData("initialize", [deployer.address]);
    const proxy = await ERC1967Proxy.deploy(implementationAddress, initData);
    await proxy.waitForDeployment();

    registryProxy = await ethers.getContractAt("OracleRegistry", await proxy.getAddress());
  } else {
    registryProxy = await upgrades.deployProxy(OracleRegistry, [deployer.address], {
      initializer: "initialize",
    });
    await registryProxy.waitForDeployment();
  }

  const registryAddress = await registryProxy.getAddress();
  console.log("✅ OracleRegistry deployed to:", registryAddress);

  // Ownership check
  const owner = await registryProxy.owner();
  console.log("OracleRegistry owner:", owner);
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`❌ Owner mismatch. Expected ${deployer.address}, got ${owner}`);
  }
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
