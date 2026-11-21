# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.9.0] - 2026-11-21

### Changed

- **Breaking (repository layout):** `PriceAdapterRegistry` moved from `contracts/price/PriceAdapterRegistry.sol` to
  `contracts/PriceAdapterRegistry.sol`. Contract name, ABI, storage layout and behavior are unchanged; only the Solidity
  source path (and therefore the artifact path under `artifacts/contracts/`) changed. The `contracts/execution/` and
  `contracts/price/` directories no longer exist.

### Removed

- **Breaking:** all execution and price adapter implementations moved to the sibling `protocol-adapters` repository
  (`@orion-finance/adapters`): `ERC4626ExecutionAdapter`, `UniswapV3ExecutionAdapter`, `ChainlinkPriceAdapter`,
  `ERC4626PriceAdapter`, `UniswapV3PoolPriceAdapter`, plus their mocks and adapter-specific tests. This repository keeps
  the core contracts and the interfaces adapters implement (`IExecutionAdapter`, `IPriceAdapter`,
  `IPriceAdapterRegistry`, `IOrionConfig`, `ErrorsLib`, ...).
- Adapter ABIs and bytecode are no longer published from this repository's `abis-v*` releases; they are published from
  `protocol-adapters`.
- `@chainlink/contracts`, `@uniswap/v3-core` and `@uniswap/v3-periphery` dependencies, the `.pnpmfile.cjs` Chainlink
  dependency-trimming hook, and the obsolete `.trivyignore.yaml` entries for the transitive OpenZeppelin 3.4.2 sources.
- `ErrorsLib.InvalidAdapter`, `InvalidPrice`, `StalePrice` and `PriceOutOfBounds` are kept even though no core contract
  reverts with them: they are raised by adapters and integrators decode these selectors from registry and orchestrator
  reverts.

## [2.8.1] - 2026-10-03

### Changed

- Removed `setVaultBeacon` from transparent and encrypted vault factories. Beacon is fixed at factory initialize; vault
  upgrades use `UpgradeableBeacon.upgradeTo` so existing and new vaults share one implementation lineage. Removed unused
  `VaultBeaconUpdated` event.
- Defense-in-depth reentrancy hardening: `depositLiquidity` and `claimVaultFees` are `nonReentrant`;
  ProcessVaultOperations sets Idle only after the vault fulfill loop so `isSystemIdle()` stays false during
  deposit/redeem settlement.
- Buffer deltas in `depositLiquidity`, `withdrawLiquidity`, and buy-leg settlement go through `SafeCast`. Amounts above
  `2^255 - 1` revert instead of inverting the buffer sign. `type(int256).min` reverts `SafeCastOverflowedIntToUint`
  instead of panicking on negation.

### Added

- Events on previously silent admin setters: `HpkePublicKeyUpdated`, `EpochDurationUpdated`,
  `ExecutionMinibatchSizeUpdated`, `MinibatchSizeUpdated`, `CommitmentMinibatchSizeUpdated` (for off-chain monitoring of
  privileged parameter changes).
- Accounting tests proving queued `fulfillDeposit` mints with `Math.Rounding.Floor` (dust under high NAV → 0 shares;
  floor ≠ ceil when remainder nonzero).
- Regression PoCs for CEI hardening (`test/reentrancy/CeiHardeningRegression.test.ts`): nested `depositLiquidity` via
  hook token, fee-manager cross-entry during `claimVaultFees`, and Idle-gated `depositLiquidity` mid-`fulfillRedeem` on
  a legacy Idle-before-fulfill twin vs production guards.
- Regression PoC for signed buffer casts (`test/math/UnsafeSignedCastRegression.test.ts`): a legacy twin accepts
  `depositLiquidity(type(uint256).max)` and shrinks the buffer by 1, while production reverts
  `SafeCastOverflowedUintToInt`. Oversized `withdrawLiquidity` transfers nothing on either path.

## [2.8.0] - 2026-10-02

### Changed

- **BREAKING:** `IOrionTransferAccessControl.canTransferShares` is now
  `(address from, address to, uint256 value, bytes data)`. Vault `_update` passes the real transfer triple so secondary
  P2P can enforce ModularCompliance-style pair/amount rules without ABI-decoding ERC-20 calldata.
- Transfer ACL ERC-165 interface ID changes with the new selector. Upgrade vault implementations and redeploy transfer
  ACL contracts in the same release window; old ACLs cannot be set on the new vault.

Versions prior to 2.8.0 were not tracked in this changelog.
