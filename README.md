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

### Install Rust dependencies

```bash
cargo install --path ./rust-fhe
```

TODO: assess necessity of rust module. If so, consider having it as a python submodule.

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

### Deploy Whitelist.

```bash
pnpm hardhat run scripts/deploy-whitelist.ts --network sepolia
```

### Add Universe Vaults to Whitelist.

TODO: Encountered error adding vault to whitelist. Verify vault address is not already whitelisted and contract deployment is correct.

```bash
cargo run --bin fhe add-to-whitelist
```

Verify whitelist contract with

```bash
pnpm hardhat run scripts/verify-whitelist.ts --network sepolia
```

### Deploy Curated Vault contract.

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

### Submit encrypted order to Vault.

```bash
cargo run --bin fhe encrypt-and-submit
```
