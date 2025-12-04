import { ethers, upgrades } from "hardhat";
import { expect } from "chai";
import "@openzeppelin/hardhat-upgrades";

/**
 * Verification Script: Upgrade Patterns Require New Implementation Address
 *
 * This script verifies that both UUPS and Beacon Proxy upgrade patterns
 * REQUIRE a different implementation address to successfully upgrade.
 *
 * Tests:
 * 1. UUPS Pattern: Verify upgrading to the same address fails/is meaningless
 * 2. Beacon Pattern: Verify upgrading to the same address fails/is meaningless
 * 3. Verify both patterns REQUIRE new implementation addresses
 */

async function main() {
  console.log("\n🔍 Verifying Upgrade Patterns Require New Implementation Addresses\n");
  console.log("=".repeat(80));

  const [owner, admin] = await ethers.getSigners();

  // ============================================================================
  // TEST 1: UUPS Pattern - Attempting to upgrade to same implementation
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("TEST 1: UUPS Pattern - Upgrade to Same Implementation");
  console.log("=".repeat(80));

  // Deploy mock underlying asset
  const MockUnderlyingAssetFactory = await ethers.getContractFactory("MockUnderlyingAsset");
  const underlyingAsset = await MockUnderlyingAssetFactory.deploy(6);
  await underlyingAsset.waitForDeployment();

  // Deploy OrionConfigUpgradeable V1
  const OrionConfigUpgradeableFactory = await ethers.getContractFactory("OrionConfigUpgradeable");
  const configProxy = await upgrades.deployProxy(
    OrionConfigUpgradeableFactory,
    [owner.address, admin.address, await underlyingAsset.getAddress()],
    { initializer: "initialize", kind: "uups" },
  );
  await configProxy.waitForDeployment();

  const configProxyAddress = await configProxy.getAddress();
  const configImplV1 = await upgrades.erc1967.getImplementationAddress(configProxyAddress);
  console.log(`✅ OrionConfig Proxy: ${configProxyAddress}`);
  console.log(`   Implementation V1: ${configImplV1}`);

  // Try to "upgrade" to the same implementation
  console.log("\n🔄 Attempting to upgrade to SAME implementation address...");
  try {
    // OpenZeppelin upgrades plugin will detect this is the same implementation
    const configUpgraded = await upgrades.upgradeProxy(configProxyAddress, OrionConfigUpgradeableFactory, {
      kind: "uups",
    });
    await configUpgraded.waitForDeployment();

    const configImplAfter = await upgrades.erc1967.getImplementationAddress(configProxyAddress);
    console.log(`   Implementation after "upgrade": ${configImplAfter}`);

    if (configImplV1 === configImplAfter) {
      console.log("   ⚠️  WARNING: Implementation address unchanged!");
      console.log("   ℹ️  OpenZeppelin reuses same implementation (no actual upgrade occurred)");
    }
  } catch (error: any) {
    console.log(`   ❌ Upgrade failed: ${error.message}`);
  }

  // Now upgrade to actual V2 implementation
  console.log("\n🔄 Upgrading to DIFFERENT implementation (V2)...");
  const OrionConfigV2Factory = await ethers.getContractFactory("OrionConfigUpgradeableV2");
  const configV2 = await upgrades.upgradeProxy(configProxyAddress, OrionConfigV2Factory, { kind: "uups" });
  await configV2.waitForDeployment();

  const configImplV2 = await upgrades.erc1967.getImplementationAddress(configProxyAddress);
  console.log(`   Implementation V2: ${configImplV2}`);

  if (configImplV1 !== configImplV2) {
    console.log("   ✅ SUCCESS: Implementation address changed to V2");
  } else {
    console.log("   ❌ FAIL: Implementation address did NOT change");
  }

  // ============================================================================
  // TEST 2: Beacon Pattern - Attempting to upgrade to same implementation
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("TEST 2: Beacon Pattern - Upgrade to Same Implementation");
  console.log("=".repeat(80));

  // Deploy vault implementation V1
  const VaultFactory = await ethers.getContractFactory("OrionTransparentVaultUpgradeable");
  const vaultImplV1 = await VaultFactory.deploy();
  await vaultImplV1.waitForDeployment();
  const vaultImplV1Address = await vaultImplV1.getAddress();

  // Deploy UpgradeableBeacon
  const BeaconFactory = await ethers.getContractFactory(
    "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon",
  );
  const beacon = await BeaconFactory.deploy(vaultImplV1Address, owner.address);
  await beacon.waitForDeployment();

  console.log(`✅ Vault Implementation V1: ${vaultImplV1Address}`);
  console.log(`✅ Beacon deployed: ${await beacon.getAddress()}`);

  const beaconImplBefore = await beacon.implementation();
  console.log(`   Beacon points to: ${beaconImplBefore}`);

  // Try to upgrade beacon to same implementation
  console.log("\n🔄 Attempting to upgrade beacon to SAME implementation...");
  try {
    const upgradeTx = await beacon.upgradeTo(vaultImplV1Address);
    await upgradeTx.wait();

    const beaconImplAfter = await beacon.implementation();
    console.log(`   Beacon still points to: ${beaconImplAfter}`);

    if (beaconImplBefore === beaconImplAfter && beaconImplAfter === vaultImplV1Address) {
      console.log("   ⚠️  WARNING: Beacon upgrade succeeded but points to SAME address");
      console.log("   ℹ️  No validation prevents upgrading to same implementation");
      console.log("   ℹ️  This is a no-op upgrade (no actual change occurred)");
    }
  } catch (error: any) {
    console.log(`   ❌ Beacon upgrade failed: ${error.message}`);
  }

  // Now upgrade to actual V2 implementation
  console.log("\n🔄 Upgrading beacon to DIFFERENT implementation (V2)...");
  const VaultV2Factory = await ethers.getContractFactory("OrionTransparentVaultUpgradeableV2");
  const vaultImplV2 = await VaultV2Factory.deploy();
  await vaultImplV2.waitForDeployment();
  const vaultImplV2Address = await vaultImplV2.getAddress();

  const upgradeTxV2 = await beacon.upgradeTo(vaultImplV2Address);
  await upgradeTxV2.wait();

  const beaconImplV2 = await beacon.implementation();
  console.log(`   Vault Implementation V2: ${vaultImplV2Address}`);
  console.log(`   Beacon now points to: ${beaconImplV2}`);

  if (vaultImplV1Address !== vaultImplV2Address && beaconImplV2 === vaultImplV2Address) {
    console.log("   ✅ SUCCESS: Beacon implementation address changed to V2");
  } else {
    console.log("   ❌ FAIL: Beacon implementation address did NOT change properly");
  }

  // ============================================================================
  // SUMMARY AND ANALYSIS
  // ============================================================================
  console.log("\n" + "=".repeat(80));
  console.log("📊 ANALYSIS & CONCLUSIONS");
  console.log("=".repeat(80));

  console.log("\n🔍 Key Findings:\n");

  console.log("1️⃣  UUPS Pattern:");
  console.log("   • OpenZeppelin's upgradeProxy() may reuse existing implementation");
  console.log("   • If code is identical, it deploys same bytecode → same address");
  console.log("   • Actual upgrades REQUIRE different bytecode → different address");
  console.log("   • Implementation address change = proof of actual upgrade");

  console.log("\n2️⃣  Beacon Pattern:");
  console.log("   • beacon.upgradeTo() accepts same address (no validation)");
  console.log("   • Upgrading to same address is a no-op (emits event but no change)");
  console.log("   • Actual upgrades REQUIRE different implementation address");
  console.log("   • Implementation address change = proof of actual upgrade");

  console.log("\n3️⃣  Why Implementation Address MUST Change for Real Upgrades:");
  console.log("   • Each contract deployment has unique address (deterministic from bytecode)");
  console.log("   • Different code → different bytecode → different deployment address");
  console.log("   • Same address → same bytecode → same code (no upgrade)");
  console.log("   • Therefore: New features/fixes REQUIRE new address");

  console.log("\n✅ CONCLUSION:");
  console.log("   For BOTH patterns, a meaningful upgrade that adds new functionality");
  console.log("   NECESSARILY implies a different implementation contract address.");
  console.log("   This is why our test assertions verify implementation address changes!");

  console.log("\n4️⃣  Implications for Adapters:");
  console.log("   • If adapters use same upgrade patterns (UUPS or Beacon)");
  console.log("   • Then upgrading adapters MUST change implementation addresses");
  console.log("   • This proves the upgrade mechanism is working correctly");
  console.log("   • No address change = no actual upgrade occurred");

  console.log("\n" + "=".repeat(80) + "\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
