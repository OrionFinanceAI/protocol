# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [2.8.0] - 2026-10-02

### Changed

- **BREAKING:** `IOrionTransferAccessControl.canTransferShares` is now
  `(address from, address to, uint256 value, bytes data)`. Vault `_update` passes the real transfer triple so secondary
  P2P can enforce ModularCompliance-style pair/amount rules without ABI-decoding ERC-20 calldata.
- Transfer ACL ERC-165 interface ID changes with the new selector. Upgrade vault implementations and redeploy transfer
  ACL contracts in the same release window; old ACLs cannot be set on the new vault.

Versions prior to 2.8.0 were not tracked in this changelog.
