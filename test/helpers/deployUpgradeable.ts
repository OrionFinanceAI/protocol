import { ethers, upgrades } from "hardhat";
import "@openzeppelin/hardhat-upgrades";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  OrionConfig,
  PriceAdapterRegistry,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  OrionTransparentVault,
  MockUnderlyingAsset,
  UpgradeableBeacon,
} from "../../typechain-types";

/**
 * Deployment result containing all upgradeable protocol contracts
 */
export interface UpgradeableProtocolContracts {
  orionConfig: OrionConfig;
  priceAdapterRegistry: PriceAdapterRegistry;
  liquidityOrchestrator: LiquidityOrchestrator;
  transparentVaultFactory: TransparentVaultFactory;
  vaultBeacon: UpgradeableBeacon;
  underlyingAsset: MockUnderlyingAsset;
}

/**
 * Deploy complete upgradeable protocol infrastructure
 *
 * This deploys:
 * - OrionConfig (UUPS)
 * - PriceAdapterRegistry (UUPS)
 * - LiquidityOrchestrator (UUPS)
 * - TransparentVaultFactory (UUPS)
 * - UpgradeableBeacon for vaults
 *
 * @param owner Protocol owner address
 * @param underlyingAsset Underlying asset contract (optional, creates mock if not provided)
 * @param automationRegistry Automation registry address (optional, defaults to owner)
 * @returns Deployed contract instances
 */
export async function deployUpgradeableProtocol(
  owner: SignerWithAddress,
  underlyingAsset?: MockUnderlyingAsset,
  automationRegistry?: SignerWithAddress,
): Promise<UpgradeableProtocolContracts> {
  // Use owner as automation registry if not provided
  const automationReg = automationRegistry || owner;

  // Deploy mock underlying asset if not provided
  let underlying = underlyingAsset;
  if (!underlying) {
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    underlying = (await MockUnderlyingAssetFactory.deploy(6)) as unknown as MockUnderlyingAsset; // USDC-like with 6 decimals
    await underlying.waitForDeployment();
  }

  // 1. Deploy OrionConfig (UUPS)
  const OrionConfigFactory = await ethers.getContractFactory("OrionConfig");
  const orionConfig = (await upgrades.deployProxy(OrionConfigFactory, [owner.address, await underlying.getAddress()], {
    initializer: "initialize",
    kind: "uups",
  })) as unknown as OrionConfig;
  await orionConfig.waitForDeployment();

  // 2. Deploy PriceAdapterRegistry (UUPS) and set in config
  const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistry");
  const priceAdapterRegistry = (await upgrades.deployProxy(
    PriceAdapterRegistryFactory,
    [owner.address, await orionConfig.getAddress()],
    { initializer: "initialize", kind: "uups" },
  )) as unknown as PriceAdapterRegistry;
  await priceAdapterRegistry.waitForDeployment();

  await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

  // 3. Deploy SP1 verifier stack (gateway routes to Groth16 verifier), then LiquidityOrchestrator (UUPS)
  const SP1VerifierGatewayFactory = await ethers.getContractFactory("SP1VerifierGateway");
  const sp1VerifierGateway = await SP1VerifierGatewayFactory.deploy(owner.address);
  await sp1VerifierGateway.waitForDeployment();

  const SP1VerifierFactory = await ethers.getContractFactory("SP1Verifier");
  const sp1VerifierGroth16 = await SP1VerifierFactory.deploy();
  await sp1VerifierGroth16.waitForDeployment();

  await sp1VerifierGateway.addRoute(await sp1VerifierGroth16.getAddress());

  // cargo run --release --bin vkey
  const vKey = "0x000c85a9a77d0cb1fb0e569acda33c6c68d31d63ae01ef5f672553772d32f779";

  const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestrator");
  const liquidityOrchestrator = (await upgrades.deployProxy(
    LiquidityOrchestratorFactory,
    [owner.address, await orionConfig.getAddress(), automationReg.address, await sp1VerifierGateway.getAddress(), vKey],
    { initializer: "initialize", kind: "uups" },
  )) as unknown as LiquidityOrchestrator;
  await liquidityOrchestrator.waitForDeployment();

  // 4. Set LiquidityOrchestrator in config
  await orionConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());

  // 5. Deploy UpgradeableBeacon for vaults
  const VaultImplFactory = await ethers.getContractFactory("OrionTransparentVault");
  const vaultImpl = await VaultImplFactory.deploy();
  await vaultImpl.waitForDeployment();

  const BeaconFactory = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon",
  );
  const vaultBeacon = (await BeaconFactory.deploy(
    await vaultImpl.getAddress(),
    owner.address,
  )) as unknown as UpgradeableBeacon;
  await vaultBeacon.waitForDeployment();

  // 6. Deploy TransparentVaultFactory (UUPS)
  const TransparentVaultFactoryFactory = await ethers.getContractFactory("TransparentVaultFactory");
  const transparentVaultFactory = (await upgrades.deployProxy(
    TransparentVaultFactoryFactory,
    [owner.address, await orionConfig.getAddress(), await vaultBeacon.getAddress()],
    { initializer: "initialize", kind: "uups" },
  )) as unknown as TransparentVaultFactory;
  await transparentVaultFactory.waitForDeployment();

  // 7. Configure OrionConfig with remaining deployed contracts
  await orionConfig.setVaultFactory(await transparentVaultFactory.getAddress());

  return {
    orionConfig,
    priceAdapterRegistry,
    liquidityOrchestrator,
    transparentVaultFactory,
    vaultBeacon,
    underlyingAsset: underlying,
  };
}

/**
 * Helper to attach to an existing vault BeaconProxy
 *
 * @param vaultAddress Address of the vault BeaconProxy
 * @returns Vault contract instance
 */
export async function attachToVault(vaultAddress: string): Promise<OrionTransparentVault> {
  const VaultFactory = await ethers.getContractFactory("OrionTransparentVault");
  return VaultFactory.attach(vaultAddress) as unknown as OrionTransparentVault;
}
