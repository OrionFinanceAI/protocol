import { ethers, upgrades } from "hardhat";
import { expect } from "chai";
import "@openzeppelin/hardhat-upgrades";

/**
 * Comprehensive Upgradeability Test Script
 *
 * This script demonstrates the complete upgrade lifecycle:
 * 1. Deploy upgradeable contracts (UUPS + Beacon Proxy)
 * 2. Test initial implementation behavior
 * 3. Deploy new implementation with enhanced functionality
 * 4. Perform upgrade
 * 5. Verify upgraded behavior
 *
 * Run with: npx hardhat run scripts/testUpgradeability.ts --network localhost
 */

async function main() {
  console.log("\n🚀 Starting Orion Protocol Upgradeability Test\n");
  console.log("=".repeat(80));

  const [owner, admin, curator, user] = await ethers.getSigners();

  console.log("\n📋 Accounts:");
  console.log(`  Owner: ${owner.address}`);
  console.log(`  Admin: ${admin.address}`);
  console.log(`  Curator: ${curator.address}`);
  console.log(`  User: ${user.address}`);

  // ============================================================================
  // STEP 1: Deploy Initial Infrastructure (Non-upgradeable)
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("STEP 1: Deploying Initial Infrastructure");
  console.log("=".repeat(80));

  // Deploy mock underlying asset
  const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
  const underlyingAsset = await MockUnderlyingAssetFactory.deploy(6);
  await underlyingAsset.waitForDeployment();
  console.log(`✅ MockUnderlyingAsset deployed: ${await underlyingAsset.getAddress()}`);

  // Deploy mock ERC4626 assets
  const MockERC4626AssetFactory = await ethers.getContractFactory("MockERC4626Asset");
  const mockAsset1 = await MockERC4626AssetFactory.deploy(await underlyingAsset.getAddress(), "Mock Asset 1", "MA1");
  await mockAsset1.waitForDeployment();
  console.log(`✅ MockAsset1 deployed: ${await mockAsset1.getAddress()}`);

  // ============================================================================
  // STEP 2: Deploy Upgradeable OrionConfig (UUPS)
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("STEP 2: Deploying OrionConfigUpgradeable (UUPS Proxy)");
  console.log("=".repeat(80));

  const OrionConfigUpgradeableFactory = await ethers.getContractFactory("OrionConfigUpgradeable");
  const orionConfigProxy = await upgrades.deployProxy(
    OrionConfigUpgradeableFactory,
    [owner.address, admin.address, await underlyingAsset.getAddress()],
    {
      initializer: "initialize",
      kind: "uups",
    },
  );
  await orionConfigProxy.waitForDeployment();

  const configProxyAddress = await orionConfigProxy.getAddress();
  const configImplAddress = await upgrades.erc1967.getImplementationAddress(configProxyAddress);

  console.log(`✅ OrionConfigUpgradeable Proxy: ${configProxyAddress}`);
  console.log(`   Implementation V1: ${configImplAddress}`);

  // Test V1 behavior
  console.log("\n📊 Testing OrionConfig V1 Behavior:");
  const underlyingFromConfig = await orionConfigProxy.underlyingAsset();
  console.log(`   Underlying Asset: ${underlyingFromConfig}`);
  expect(underlyingFromConfig).to.equal(await underlyingAsset.getAddress());
  console.log("   ✓ Underlying asset correctly set");

  // ============================================================================
  // STEP 3: Deploy Upgradeable PriceAdapterRegistry (UUPS)
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("STEP 3: Deploying PriceAdapterRegistryUpgradeable (UUPS Proxy)");
  console.log("=".repeat(80));

  const PriceAdapterRegistryUpgradeableFactory = await ethers.getContractFactory("PriceAdapterRegistryUpgradeable");
  const priceRegistryProxy = await upgrades.deployProxy(
    PriceAdapterRegistryUpgradeableFactory,
    [owner.address, configProxyAddress],
    {
      initializer: "initialize",
      kind: "uups",
    },
  );
  await priceRegistryProxy.waitForDeployment();

  const registryProxyAddress = await priceRegistryProxy.getAddress();
  const registryImplAddress = await upgrades.erc1967.getImplementationAddress(registryProxyAddress);

  console.log(`✅ PriceAdapterRegistry Proxy: ${registryProxyAddress}`);
  console.log(`   Implementation V1: ${registryImplAddress}`);

  // Set registry in config
  await orionConfigProxy.setPriceAdapterRegistry(registryProxyAddress);
  console.log("   ✓ Registry set in OrionConfig");

  // ============================================================================
  // STEP 4: Deploy Orchestrators (UUPS)
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("STEP 4: Deploying Orchestrators (UUPS Proxies)");
  console.log("=".repeat(80));

  // Deploy InternalStatesOrchestrator
  const InternalStatesOrchestratorUpgradeableFactory = await ethers.getContractFactory(
    "InternalStatesOrchestratorUpgradeable",
  );
  const internalStatesProxy = await upgrades.deployProxy(
    InternalStatesOrchestratorUpgradeableFactory,
    [owner.address, configProxyAddress, admin.address],
    {
      initializer: "initialize",
      kind: "uups",
    },
  );
  await internalStatesProxy.waitForDeployment();
  console.log(`✅ InternalStatesOrchestrator Proxy: ${await internalStatesProxy.getAddress()}`);

  // Deploy LiquidityOrchestrator
  const LiquidityOrchestratorUpgradeableFactory = await ethers.getContractFactory("LiquidityOrchestratorUpgradeable");
  const liquidityProxy = await upgrades.deployProxy(
    LiquidityOrchestratorUpgradeableFactory,
    [owner.address, configProxyAddress, admin.address],
    {
      initializer: "initialize",
      kind: "uups",
    },
  );
  await liquidityProxy.waitForDeployment();
  console.log(`✅ LiquidityOrchestrator Proxy: ${await liquidityProxy.getAddress()}`);

  // Set orchestrators in config
  await orionConfigProxy.setInternalStatesOrchestrator(await internalStatesProxy.getAddress());
  await orionConfigProxy.setLiquidityOrchestrator(await liquidityProxy.getAddress());
  console.log("   ✓ Orchestrators set in OrionConfig");

  // ============================================================================
  // STEP 5: Deploy Vault Beacon + Implementation
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("STEP 5: Deploying Vault Beacon Proxy Setup");
  console.log("=".repeat(80));

  // Deploy vault implementation V1
  const OrionTransparentVaultUpgradeableFactory = await ethers.getContractFactory("OrionTransparentVaultUpgradeable");
  const vaultImplementationV1 = await OrionTransparentVaultUpgradeableFactory.deploy();
  await vaultImplementationV1.waitForDeployment();
  console.log(`✅ Vault Implementation V1: ${await vaultImplementationV1.getAddress()}`);

  // Deploy UpgradeableBeacon pointing to implementation
  const UpgradeableBeaconFactory = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon",
  );
  const vaultBeacon = await UpgradeableBeaconFactory.deploy(await vaultImplementationV1.getAddress(), owner.address);
  await vaultBeacon.waitForDeployment();
  console.log(`✅ Vault Beacon: ${await vaultBeacon.getAddress()}`);

  // ============================================================================
  // STEP 6: Deploy Factory (UUPS) with Beacon
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("STEP 6: Deploying TransparentVaultFactoryUpgradeable (UUPS)");
  console.log("=".repeat(80));

  const TransparentVaultFactoryUpgradeableFactory = await ethers.getContractFactory(
    "TransparentVaultFactoryUpgradeable",
  );
  const factoryProxy = await upgrades.deployProxy(
    TransparentVaultFactoryUpgradeableFactory,
    [owner.address, configProxyAddress, await vaultBeacon.getAddress()],
    {
      initializer: "initialize",
      kind: "uups",
    },
  );
  await factoryProxy.waitForDeployment();
  console.log(`✅ Factory Proxy: ${await factoryProxy.getAddress()}`);

  // Set factory in config
  await orionConfigProxy.setVaultFactory(await factoryProxy.getAddress());
  console.log("   ✓ Factory set in OrionConfig");

  // ============================================================================
  // STEP 7: Create Vault via BeaconProxy
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("STEP 7: Creating Vault via Factory (BeaconProxy Pattern)");
  console.log("=".repeat(80));

  // Deploy adapters for the mock asset
  const MockPriceAdapterFactory = await ethers.getContractFactory("MockPriceAdapter");
  const mockPriceAdapter = await MockPriceAdapterFactory.deploy();
  await mockPriceAdapter.waitForDeployment();

  const MockExecutionAdapterFactory = await ethers.getContractFactory("MockExecutionAdapter");
  const mockExecutionAdapter = await MockExecutionAdapterFactory.deploy();
  await mockExecutionAdapter.waitForDeployment();

  // Whitelist vault owner and asset (check if already whitelisted first)
  const isOwnerWhitelisted = await orionConfigProxy.isWhitelistedVaultOwner(owner.address);
  if (!isOwnerWhitelisted) {
    await orionConfigProxy.addWhitelistedVaultOwner(owner.address);
  }

  const isAssetWhitelisted = await orionConfigProxy.isWhitelisted(await mockAsset1.getAddress());
  if (!isAssetWhitelisted) {
    await orionConfigProxy.addWhitelistedAsset(
      await mockAsset1.getAddress(),
      await mockPriceAdapter.getAddress(),
      await mockExecutionAdapter.getAddress(),
    );
  }
  console.log("   ✓ Whitelisted vault owner and asset");

  // Create vault through factory
  const createVaultTx = await factoryProxy.createVault(
    curator.address,
    "Orion Test Vault",
    "OTV",
    0, // feeType: ABSOLUTE
    100, // performanceFee: 1%
    50, // managementFee: 0.5%
    ethers.ZeroAddress, // permissionless deposits
  );
  const receipt = await createVaultTx.wait();

  // Get vault address from event
  const vaultCreatedEvent = receipt.logs.find((log: unknown) => {
    const parsed = log as { fragment?: { name?: string }; args?: string[] };
    return parsed.fragment && parsed.fragment.name === "OrionVaultCreated";
  }) as { args: string[] } | undefined;

  if (!vaultCreatedEvent || !vaultCreatedEvent.args[0]) {
    throw new Error("OrionVaultCreated event not found or invalid");
  }

  const vaultAddress: string = vaultCreatedEvent.args[0];
  console.log(`✅ Vault Created (BeaconProxy): ${vaultAddress}`);

  // Connect to vault
  const vault = OrionTransparentVaultUpgradeableFactory.attach(vaultAddress);

  // Test V1 vault behavior
  console.log("\n📊 Testing Vault V1 Behavior:");
  const vaultName = await vault.name();
  const vaultSymbol = await vault.symbol();
  const vaultOwnerAddress = await vault.vaultOwner();
  console.log(`   Name: ${vaultName}`);
  console.log(`   Symbol: ${vaultSymbol}`);
  console.log(`   Owner: ${vaultOwnerAddress}`);
  expect(vaultName).to.equal("Orion Test Vault");
  expect(vaultSymbol).to.equal("OTV");
  expect(vaultOwnerAddress).to.equal(owner.address);
  console.log("   ✓ All V1 vault properties correct");

  // ============================================================================
  // STEP 8: Simulate Upgrade - Deploy V2 Implementation (Beacon Pattern)
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("STEP 8: BEACON UPGRADE - Deploy Vault V2 Implementation");
  console.log("=".repeat(80));
  console.log("\n📦 Deploying OrionTransparentVaultUpgradeableV2 with new features...\n");

  // Deploy new vault implementation V2 with enhanced functionality
  const OrionTransparentVaultUpgradeableV2Factory = await ethers.getContractFactory(
    "OrionTransparentVaultUpgradeableV2",
  );
  const vaultImplementationV2 = await OrionTransparentVaultUpgradeableV2Factory.deploy();
  await vaultImplementationV2.waitForDeployment();
  console.log(`✅ Vault Implementation V2: ${await vaultImplementationV2.getAddress()}`);

  // Check current beacon implementation before upgrade
  const currentImpl = await vaultBeacon.implementation();
  console.log(`   Current Beacon Implementation: ${currentImpl}`);
  expect(currentImpl).to.equal(await vaultImplementationV1.getAddress());
  console.log("   ✓ V1 implementation confirmed");

  // Upgrade beacon to point to V2
  console.log("\n🔄 Upgrading Beacon to V2...");
  const upgradeTx = await vaultBeacon.upgradeTo(await vaultImplementationV2.getAddress());
  await upgradeTx.wait();

  // Verify upgrade - implementation address should change
  const newImpl = await vaultBeacon.implementation();
  console.log(`✅ Beacon upgraded to: ${newImpl}`);
  expect(newImpl).to.equal(await vaultImplementationV2.getAddress());
  expect(newImpl).to.not.equal(currentImpl);
  console.log("   ✓ Implementation address changed successfully");

  // ============================================================================
  // STEP 9: Test Vault After Upgrade (Verify V2 Features)
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("STEP 9: Testing Vault After Beacon Upgrade");
  console.log("=".repeat(80));

  // Attach vault proxy to V2 contract interface to access new functions
  const vaultV2 = OrionTransparentVaultUpgradeableV2Factory.attach(vaultAddress);

  // Verify existing state is preserved
  const vaultNameAfter = await vaultV2.name();
  const vaultSymbolAfter = await vaultV2.symbol();
  const vaultOwnerAfterUpgrade = await vaultV2.vaultOwner();

  console.log("\n📊 Vault State After Upgrade:");
  console.log(`   Name: ${vaultNameAfter}`);
  console.log(`   Symbol: ${vaultSymbolAfter}`);
  console.log(`   Owner: ${vaultOwnerAfterUpgrade}`);

  expect(vaultNameAfter).to.equal("Orion Test Vault");
  expect(vaultSymbolAfter).to.equal("OTV");
  expect(vaultOwnerAfterUpgrade).to.equal(owner.address);
  console.log("   ✓ State preserved after upgrade!");

  // Test V2-specific functionality
  console.log("\n🆕 Testing V2 New Features:");
  const version = await vaultV2.version();
  console.log(`   Version: ${version}`);
  expect(version).to.equal("v2");
  console.log("   ✓ V2 version() function works!");

  // Test new setVaultDescription function
  const testDescription = "This is a test vault upgraded to V2";
  await vaultV2.setVaultDescription(testDescription);
  const description = await vaultV2.vaultDescription();
  console.log(`   Description: ${description}`);
  expect(description).to.equal(testDescription);
  console.log("   ✓ V2 setVaultDescription() function works!");

  // ============================================================================
  // STEP 10: Upgrade UUPS Contract (OrionConfig V2)
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("STEP 10: UUPS UPGRADE - Deploy OrionConfig V2 Implementation");
  console.log("=".repeat(80));
  console.log("\n📦 Deploying OrionConfigUpgradeableV2 with new features...\n");

  // Get current implementation address before upgrade
  const configImplV1Address = await upgrades.erc1967.getImplementationAddress(configProxyAddress);
  console.log(`   Current Implementation V1: ${configImplV1Address}`);

  // Deploy new OrionConfig V2 implementation with enhanced functionality
  const OrionConfigV2Factory = await ethers.getContractFactory("OrionConfigUpgradeableV2");

  console.log("\n🔄 Upgrading OrionConfig to V2 via UUPS...");
  const configUpgraded = await upgrades.upgradeProxy(configProxyAddress, OrionConfigV2Factory, {
    kind: "uups",
  });
  await configUpgraded.waitForDeployment();

  // Get new implementation address after upgrade
  const configImplV2Address = await upgrades.erc1967.getImplementationAddress(configProxyAddress);
  console.log(`✅ OrionConfig Implementation V2: ${configImplV2Address}`);
  console.log(`   Proxy address unchanged: ${configProxyAddress}`);

  // Verify implementation address changed
  expect(configImplV2Address).to.not.equal(configImplV1Address);
  console.log("   ✓ Implementation address changed successfully");

  // Verify state preserved
  const underlyingAfterUpgrade = await configUpgraded.underlyingAsset();
  expect(underlyingAfterUpgrade).to.equal(await underlyingAsset.getAddress());
  console.log("   ✓ OrionConfig state preserved after UUPS upgrade!");

  // Test V2-specific functionality
  console.log("\n🆕 Testing V2 New Features:");
  const configVersion = await configUpgraded.version();
  console.log(`   Version: ${configVersion}`);
  expect(configVersion).to.equal("v2");
  console.log("   ✓ V2 version() function works!");

  // Test new setV2Variable function
  const testValue = 12345;
  await configUpgraded.setV2Variable(testValue);
  const v2Variable = await configUpgraded.newV2Variable();
  console.log(`   New V2 Variable: ${v2Variable}`);
  expect(v2Variable).to.equal(testValue);
  console.log("   ✓ V2 setV2Variable() function works!");

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("✅ UPGRADE TEST COMPLETE");
  console.log("=".repeat(80));
  console.log("\n📋 Summary:");
  console.log("  ✅ Deployed UUPS contracts (OrionConfig, Registry, Orchestrators, Factory)");
  console.log("  ✅ Deployed Beacon Proxy pattern for vaults");
  console.log("  ✅ Created vault through factory");
  console.log("  ✅ Tested V1 behavior");
  console.log("  ✅ Upgraded vault implementation via Beacon (V1 → V2)");
  console.log("  ✅ Verified implementation address changed for vault");
  console.log("  ✅ Verified state preservation after vault upgrade");
  console.log("  ✅ Tested new V2 vault features (version(), setVaultDescription())");
  console.log("  ✅ Upgraded OrionConfig via UUPS (V1 → V2)");
  console.log("  ✅ Verified implementation address changed for config");
  console.log("  ✅ Verified state preservation after UUPS upgrade");
  console.log("  ✅ Tested new V2 config features (version(), setV2Variable())");

  console.log("\n🎯 Key Takeaways:");
  console.log("  • Beacon Pattern: All vaults upgrade at once when beacon is updated");
  console.log("  • UUPS Pattern: Each contract upgrades independently via upgradeProxy()");
  console.log("  • Implementation addresses change after upgrade (V1 ≠ V2)");
  console.log("  • Proxy addresses never change, only implementation addresses");
  console.log("  • State is preserved across all upgrades");
  console.log("  • New functions added in V2 work correctly");
  console.log("  • V2 contracts can add state variables using storage gaps");

  console.log("\n" + "=".repeat(80) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
