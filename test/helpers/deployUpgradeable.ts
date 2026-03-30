import { ethers } from "./hh";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import type {
  OrionConfig,
  PriceAdapterRegistry,
  LiquidityOrchestrator,
  TransparentVaultFactory,
  OrionTransparentVault,
  MockUnderlyingAsset,
  UpgradeableBeacon,
} from "../typechain-types";

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

export async function deployUUPSProxy<TContract>(contractName: string, initializeArgs: unknown[]): Promise<TContract> {
  const implFactory = await ethers.getContractFactory(contractName);
  const implementation = await implFactory.deploy();
  await implementation.waitForDeployment();

  const initData = implFactory.interface.encodeFunctionData("initialize", initializeArgs);
  const proxyFactory = await ethers.getContractFactory("OrionERC1967Proxy");
  const proxy = await proxyFactory.deploy(await implementation.getAddress(), initData);
  await proxy.waitForDeployment();

  return implFactory.attach(await proxy.getAddress()) as unknown as TContract;
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

  // 1. Deploy OrionConfig proxy
  const orionConfig = await deployUUPSProxy<OrionConfig>("OrionConfig", [owner.address, await underlying.getAddress()]);

  // 2. Deploy PriceAdapterRegistry proxy and set in config
  const priceAdapterRegistry = await deployUUPSProxy<PriceAdapterRegistry>("PriceAdapterRegistry", [
    owner.address,
    await orionConfig.getAddress(),
  ]);

  await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());

  // 3. Deploy SP1 verifier stack (gateway routes to Groth16 verifier), then LiquidityOrchestrator proxy
  const SP1VerifierGatewayFactory = await ethers.getContractFactory("SP1VerifierGateway");
  const sp1VerifierGateway = await SP1VerifierGatewayFactory.deploy(owner.address);
  await sp1VerifierGateway.waitForDeployment();

  const SP1VerifierFactory = await ethers.getContractFactory("SP1Verifier");
  const sp1VerifierGroth16 = await SP1VerifierFactory.deploy();
  await sp1VerifierGroth16.waitForDeployment();

  await sp1VerifierGateway.addRoute(await sp1VerifierGroth16.getAddress());

  // cargo run --release --bin vkey
  const vKey = "0x007ccff4696ddd1d62fec2a106aa50309ba0fdee8fc2bcbc9c0b5ea68fe200f3";

  const liquidityOrchestrator = await deployUUPSProxy<LiquidityOrchestrator>("LiquidityOrchestrator", [
    owner.address,
    await orionConfig.getAddress(),
    automationReg.address,
    await sp1VerifierGateway.getAddress(),
    vKey,
  ]);

  // 4. Set LiquidityOrchestrator in config
  await orionConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());

  // 5. Deploy UpgradeableBeacon for vaults
  const VaultImplFactory = await ethers.getContractFactory("OrionTransparentVault");
  const vaultImpl = await VaultImplFactory.deploy();
  await vaultImpl.waitForDeployment();

  const BeaconFactory = await ethers.getContractFactory("OrionUpgradeableBeacon");
  const vaultBeacon = (await BeaconFactory.deploy(
    await vaultImpl.getAddress(),
    owner.address,
  )) as unknown as UpgradeableBeacon;
  await vaultBeacon.waitForDeployment();

  // 6. Deploy TransparentVaultFactory proxy
  const transparentVaultFactory = await deployUUPSProxy<TransparentVaultFactory>("TransparentVaultFactory", [
    owner.address,
    await orionConfig.getAddress(),
    await vaultBeacon.getAddress(),
  ]);

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
