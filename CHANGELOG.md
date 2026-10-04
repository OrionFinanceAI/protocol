# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.8.1] - 2026-10-03

### Changed

- Removed `setVaultBeacon` from transparent and encrypted vault factories. Beacon is fixed at factory initialize; vault
  upgrades use `UpgradeableBeacon.upgradeTo` so existing and new vaults share one implementation lineage. Removed unused
  `VaultBeaconUpdated` event.
- Defense-in-depth reentrancy hardening: `depositLiquidity` and `claimVaultFees` are `nonReentrant`;
  ProcessVaultOperations sets Idle only after the vault fulfill loop so `isSystemIdle()` stays false during
  deposit/redeem settlement.

### Added

- Events on previously silent admin setters: `HpkePublicKeyUpdated`, `EpochDurationUpdated`,
  `ExecutionMinibatchSizeUpdated`, `MinibatchSizeUpdated`, `CommitmentMinibatchSizeUpdated` (for off-chain monitoring of
  privileged parameter changes).
- Accounting tests proving queued `fulfillDeposit` mints with `Math.Rounding.Floor` (dust under high NAV → 0 shares;
  floor ≠ ceil when remainder nonzero).
- Regression PoCs for CEI hardening (`test/reentrancy/CeiHardeningRegression.test.ts`): nested `depositLiquidity` via
  hook token, fee-manager cross-entry during `claimVaultFees`, and Idle-gated `depositLiquidity` mid-`fulfillRedeem` on
  a legacy Idle-before-fulfill twin vs production guards.

## [2.8.0] - 2026-10-02

### Changed

- **BREAKING:** `IOrionTransferAccessControl.canTransferShares` is now
  `(address from, address to, uint256 value, bytes data)`. Vault `_update` passes the real transfer triple so secondary
  P2P can enforce ModularCompliance-style pair/amount rules without ABI-decoding ERC-20 calldata.
- Transfer ACL ERC-165 interface ID changes with the new selector. Upgrade vault implementations and redeploy transfer
  ACL contracts in the same release window; old ACLs cannot be set on the new vault.

Versions prior to 2.8.0 were not tracked in this changelog.
