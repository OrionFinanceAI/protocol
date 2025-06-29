# protocol 

<div align="center">

[![Github Actions][gha-badge]][gha] [![Hardhat][hardhat-badge]][hardhat] [![Discord][discord-badge]][discord]

</div>

[gha]: https://github.com/OrionFinanceAI/protocol/actions
[gha-badge]: https://github.com/OrionFinanceAI/protocol/actions/workflows/ci.yml/badge.svg
[hardhat]: https://hardhat.org/
[hardhat-badge]: https://img.shields.io/badge/Built%20with-Hardhat-FFDB1C.svg
[discord]: https://discord.gg/8bAXxPSPdw
[discord-badge]: https://img.shields.io/badge/discord-join%20chat-5865F2?logo=discord&logoColor=white

![orion](./assets/OF_lockup_white.png)


## About

Orion Finance is a permissionless portfolio management protocol designed to optimize onchain capital efficiency while preserving privacy for managers and auditability for users. It enables anyone to create, manage, and invest in structured portfolios through modular, yield-bearing vaults. 

At its core, Orion is building a next-generation permissionless infrastructure that democratizes access to advanced portfolio strategies and lowers the barrier to entry for managers to participate in a marketplace of indexes and actively managed DeFi products.

## Licences

The license for Orion is the Business Source License 1.1 (`BUSL-1.1`) given in [`LICENSE`](./LICENSE).

## Installation

```bash
uv venv 
source .venv/bin/activate
uv pip install slither-analyzer
pnpm install
```

## Examples of Usage

```bash
./scripts/localhost_deployer.sh
```

```bash
pnpm hardhat run scripts/request-vault-deposit.ts --network localhost
pnpm hardhat run scripts/simulate-chainlink-automation.ts --network localhost
# pnpm hardhat run scripts/request-vault-withdrawal.ts --network localhost
```

## Processes

```bash
pnpm hardhat run scripts/advance-time.ts --network localhost
```