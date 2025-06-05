# protocol

## About

Orion Finance is a permissionless portfolio management protocol designed to optimize onchain capital efficiency while preserving privacy for managers and auditability for users. It enables anyone to create, manage, and invest in structured portfolios through modular, yield-bearing vaults. 

At its core, Orion is building a next-generation permissionless infrastructure that democratizes access to advanced portfolio strategies and lowers the barrier to entry for managers to participate in a marketplace of indexes and actively managed DeFi products.

## Licences

The license for Orion is the Business Source License 1.1 (`BUSL-1.1`) given in [`LICENSE`](./LICENSE).

## Installation

### Install Node dependencies

```bash
pnpm install
```

### Install Python dependencies

```bash
cd python-sdk
uv venv
source .venv/bin/activate
uv pip install -e .
```

## Development Scripts

### Generate FHE key pair and upload public key to IPFS.

```bash
cd python-sdk
sdk keygen
sdk upload context.public.tenseal
```

### Verify Config

```bash
pnpm hardhat run scripts/verify-config.ts --network sepolia
```

### Deposit USDC to Vault for share token.

```bash
pnpm hardhat run scripts/deposit-to-vault.ts --network sepolia
```