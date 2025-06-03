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

## Scripts

### Generate addresses for Deployer, LP, Curator.

```bash
cast wallet new-mnemonic
```

### Generate FHE key pair and upload public key to IPFS.

```bash
cd python-sdk
sdk keygen
sdk upload context.public.tenseal
```

### Deploy MockUSDC contract.

```bash
pnpm hardhat run scripts/deploy-mock-usdc.ts --network sepolia
```

### Mint MockUSDC to LP.

```bash
pnpm hardhat run scripts/mint-mock-usdc-to-lp.ts --network sepolia
```

### Deploy Investment Universe.

```bash
pnpm hardhat run scripts/deploy-investment-universe.ts --network sepolia
```

### Deploy Config.

```bash
pnpm hardhat run scripts/deploy-config.ts --network sepolia
``` 

Verify config contract with:

```bash
pnpm hardhat run scripts/verify-config.ts --network sepolia
```

### Add Universe Vaults to Config Whitelist.

```bash
pnpm hardhat run scripts/add-to-config-whitelist.ts --network sepolia
```

### Deploy Orion Vault Factory.

```bash
pnpm hardhat run scripts/deploy-orion-vault-factory.ts --network sepolia
```

### Deploy Orion Vault contract.

```bash
pnpm hardhat run scripts/deploy-curated-vault.ts --network sepolia
```

Verify vault contract with

```bash
pnpm hardhat run scripts/verify-curated-vault.ts --network sepolia
```

### Deposit USDC to Vault for share token.

```bash
pnpm hardhat run scripts/deposit-to-vault.ts --network sepolia
```

### Submit encrypted order to Orion Vault.

TODO: Implement encrypted order submission.