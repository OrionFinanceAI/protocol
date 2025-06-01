# protocol

## Installation

```bash
pnpm install
```

## Scripts

```bash
cast wallet new-mnemonic
node scripts/generate-fhe-keys.js

pnpm hardhat run scripts/deploy.ts --network sepolia
pnpm hardhat run scripts/mint-mock-usdc-to-lp.ts --network sepolia
pnpm hardhat run scripts/depositToVault.ts --network sepolia
pnpm hardhat run scripts/submitEncryptedOrder.ts --network sepolia
```

```bash
pnpm hardhat verify --network sepolia 0x98625125251CF3d4b6eBABC2C06ebBB37B2C957a 0xD4aCA3f915627611172F56D85bc1a1478aeC6427 0xde1F4FeE2886fF17294DCC3fE13033A4dB9B6545 0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20
```


## Overview

LPs are able to deposit USDC (ERC20) tokens into a vault, and get share token in exchange. The curator, associated with the vault, is submitting FHE-encrypted rebalancing orders to a batcher, asynchronously performing sum of encrypted vectors using Zama coprocessor. The output of the batcher is decrypted by another module calling Zama coprocessor, that cannot decrypt individual batched states. such module behaves as the curator of a liquidity pool, collecting all the USDC liquidity associated with such orders. The pool is then dispaching the liquidity across an array of ERC4626 tokens and gets an array of share tokens. A chainlink oracle is responsible for measuring the profit and loss of the investment universe between two epochs. This PandL vector is passed to and FHE computer, performing a dot product between curators intents and plaintext returns. These returns are used to update the frontend vaults prices. USDC liqudity is backpropagate as little as possible and as much as necessary.

# Module-by-module Breakdown

## Frontend Vault

Price Update: Triggered externally from P&L computation

Data: Plaintext

FHE Role: ❌ none

Trust Assumption: Fully transparent vault

## Vault Curator

Role: Decides allocation preferences

Output: Encrypted allocation vector

Data: FHE

FHE Role: ✅ encrypts intent vector

Trust Assumption: Strategy must remain private (even from execution engine)

## Batcher

Input: Many encrypted vectors from curators

Action: Homomorphic sum (Zama coprocessor)

Output: Encrypted sum vector

Data: FHE

FHE Role: ✅ sum encrypted intent vectors

Trust Assumption: Cannot decrypt anything — operates only on FHE ciphertexts

## Decryption Module

Input: Encrypted batch sum

Action: Calls Zama coprocessor to decrypt only the aggregate

Output: Plaintext sum of rebalancing intentions

Data: From FHE → Plaintext

FHE Role: ✅ controlled decryption

Trust Assumption: Cannot access individual intent vectors; only batched sum

## Liquidity Pool Allocator

Input: Total available USDC + plaintext allocation vector

Action: Allocates to array of ERC4626 strategies (e.g. Yearn/Aave)

Output: Array of ERC4626 strategy shares

Data: Plaintext

FHE Role: ❌ none

Trust Assumption: Must execute allocation faithfully, auditable on-chain

## Investment Strategies (Array of ERC4626 tokens)

Type: Existing yield strategies

Data: Plaintext

FHE Role: ❌ none

Note: Outputs strategy-specific shares, visible on-chain

## Chainlink Oracle

Input: Time t₀ and t₁ price of each ERC4626 strategy

Output: Plaintext P&L vector

Data: Plaintext

FHE Role: ❌ none

Trust Assumption: Verifiable external oracle (Chainlink)

## FHE Computer (Return Attribution)

Input: Encrypted allocation intent vectors + plaintext P&L vector

Action: Homomorphic dot product to compute each vault's return

Output: Decrypted vault-level return

Data: FHE to Plaintext

FHE Role: ✅ compute dot product under encryption

Trust Assumption: Curator strategies not revealed; only their return is revealed

## Vault Price Updater

Input: Return factor (e.g., 0.99, 1.04)

Action: Adjust internal totalAssets() or share price accordingly

Data: Plaintext

FHE Role: ❌ none

Trust Assumption: Receives only scalar return, not allocation vector.

Note: Vault share prices are updated based on returns — not requiring asset movement. We move assets as little as possible and as much as necessary. This avoids [gas-heavy back-and-forth](https://github.com/OrionFinanceAI/orionfinance-app/blob/91ede5ef8cc37687cd4b8b42ba534d1fed79711d/app.py) rebalancing, instead letting price variation reflect performance.