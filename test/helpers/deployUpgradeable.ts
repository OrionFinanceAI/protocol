import { ethers, upgrades } from "hardhat";
import "@openzeppelin/hardhat-upgrades";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import {
  OrionConfigUpgradeable,
  PriceAdapterRegistryUpgradeable,
  InternalStatesOrchestratorUpgradeable,
  LiquidityOrchestratorUpgradeable,
  TransparentVaultFactoryUpgradeable,
  OrionTransparentVaultUpgradeable,
  MockUnderlyingAsset,
} from "../../typechain-types";

/**
 * Deployment result containing all upgradeable protocol contracts
 */
export interface UpgradeableProtocolContracts {
  orionConfig: OrionConfigUpgradeable;
  priceAdapterRegistry: PriceAdapterRegistryUpgradeable;
  internalStatesOrchestrator: InternalStatesOrchestratorUpgradeable;
  liquidityOrchestrator: LiquidityOrchestratorUpgradeable;
  transparentVaultFactory: TransparentVaultFactoryUpgradeable;
  vaultBeacon: unknown; // UpgradeableBeacon instance
  underlyingAsset: MockUnderlyingAsset;
}

/**
 * Deploy complete upgradeable protocol infrastructure
 *
 * This deploys:
 * - OrionConfigUpgradeable (UUPS)
 * - PriceAdapterRegistryUpgradeable (UUPS)
 * - InternalStatesOrchestratorUpgradeable (UUPS)
 * - LiquidityOrchestratorUpgradeable (UUPS)
 * - TransparentVaultFactoryUpgradeable (UUPS)
 * - UpgradeableBeacon for vaults
 *
 * @param owner Protocol owner address
 * @param admin Protocol admin address
 * @param underlyingAsset Underlying asset contract (optional, creates mock if not provided)
 * @param automationRegistry Automation registry address (optional, defaults to admin)
 * @returns Deployed contract instances
 */
export async function deployUpgradeableProtocol(
  owner: SignerWithAddress,
  admin: SignerWithAddress,
  underlyingAsset?: MockUnderlyingAsset,
  automationRegistry?: SignerWithAddress,
): Promise<UpgradeableProtocolContracts> {
  // Use admin as automation registry if not provided
  const automationReg = automationRegistry || admin;

  // Deploy mock underlying asset if not provided
  let underlying = underlyingAsset;
  if (!underlying) {
    const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
    underlying = await MockUnderlyingAssetFactory.deploy(6); // USDC-like with 6 decimals
    await underlying.waitForDeployment();
  }

  // 1. Deploy OrionConfigUpgradeable (UUPS)
  const OrionConfigFactory = await ethers.getContractFactory("OrionConfigUpgradeable");
  const orionConfig = (await upgrades.deployProxy(
    OrionConfigFactory,
    [owner.address, admin.address, await underlying.getAddress()],
    { initializer: "initialize", kind: "uups" },
  )) as unknown as OrionConfigUpgradeable;
  await orionConfig.waitForDeployment();

  // 2. Deploy PriceAdapterRegistryUpgradeable (UUPS)
  const PriceAdapterRegistryFactory = await ethers.getContractFactory("PriceAdapterRegistryUpgradeable");
  const priceAdapterRegistry = (await upgrades.deployProxy(
    PriceAdapterRegistryFactory,
    [owner.address, await orionConfig.getAddress()],
    { initializer: "initialize", kind: "uups" },
  )) as unknown as PriceAdapterRegistryUpgradeable;
  await priceAdapterRegistry.waitForDeployment();

  // 3. Deploy LiquidityOrchestratorUpgradeable (UUPS) - MUST be before InternalStatesOrchestrator
  const LiquidityOrchestratorFactory = await ethers.getContractFactory("LiquidityOrchestratorUpgradeable");
  const liquidityOrchestrator = (await upgrades.deployProxy(
    LiquidityOrchestratorFactory,
    [owner.address, await orionConfig.getAddress(), automationReg.address],
    { initializer: "initialize", kind: "uups" },
  )) as unknown as LiquidityOrchestratorUpgradeable;
  await liquidityOrchestrator.waitForDeployment();

  // 4. Set LiquidityOrchestrator in config BEFORE deploying InternalStatesOrchestrator
  await orionConfig.setLiquidityOrchestrator(await liquidityOrchestrator.getAddress());

  // 5. Deploy InternalStatesOrchestratorUpgradeable (UUPS) - reads liquidityOrchestrator from config
  const InternalStatesOrchestratorFactory = await ethers.getContractFactory("InternalStatesOrchestratorUpgradeable");
  const internalStatesOrchestrator = (await upgrades.deployProxy(
    InternalStatesOrchestratorFactory,
    [owner.address, await orionConfig.getAddress(), automationReg.address],
    { initializer: "initialize", kind: "uups" },
  )) as unknown as InternalStatesOrchestratorUpgradeable;
  await internalStatesOrchestrator.waitForDeployment();

  // 5. Deploy UpgradeableBeacon for vaults
  const VaultImplFactory = await ethers.getContractFactory("OrionTransparentVaultUpgradeable");
  const vaultImpl = await VaultImplFactory.deploy();
  await vaultImpl.waitForDeployment();

  const BeaconFactory = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon",
  );
  const vaultBeacon = await BeaconFactory.deploy(await vaultImpl.getAddress(), owner.address);
  await vaultBeacon.waitForDeployment();

  // 6. Deploy TransparentVaultFactoryUpgradeable (UUPS)
  const TransparentVaultFactoryFactory = await ethers.getContractFactory("TransparentVaultFactoryUpgradeable");
  const transparentVaultFactory = (await upgrades.deployProxy(
    TransparentVaultFactoryFactory,
    [owner.address, await orionConfig.getAddress(), await vaultBeacon.getAddress()],
    { initializer: "initialize", kind: "uups" },
  )) as unknown as TransparentVaultFactoryUpgradeable;
  await transparentVaultFactory.waitForDeployment();

  // 7. Configure OrionConfig with remaining deployed contracts
  await orionConfig.setPriceAdapterRegistry(await priceAdapterRegistry.getAddress());
  await orionConfig.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());
  // Note: LiquidityOrchestrator was already set before InternalStatesOrchestrator deployment
  await orionConfig.setVaultFactory(await transparentVaultFactory.getAddress());

  // 8. Link orchestrators (LiquidityOrchestrator needs InternalStatesOrchestrator reference)
  await liquidityOrchestrator.setInternalStatesOrchestrator(await internalStatesOrchestrator.getAddress());

  return {
    orionConfig,
    priceAdapterRegistry,
    internalStatesOrchestrator,
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
export async function attachToVault(vaultAddress: string): Promise<OrionTransparentVaultUpgradeable> {
  const VaultFactory = await ethers.getContractFactory("OrionTransparentVaultUpgradeable");
  return VaultFactory.attach(vaultAddress) as unknown as OrionTransparentVaultUpgradeable;
}
