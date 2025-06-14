"""Interactions with the Orion contracts."""

import json
import os
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from web3 import Web3

env_path = Path(__file__).resolve().parent.parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

ABIS_PATH = Path(__file__).resolve().parent.parent.parent / "artifacts" / "contracts"

# w3 = Web3(Web3.HTTPProvider(os.getenv("RPC_URL")))
w3 = Web3(Web3.HTTPProvider("http://127.0.0.1:8545"))


def load_contract_abi(contract_name: str) -> list[dict]:
    """Load the ABI for a given contract."""
    with open(ABIS_PATH / f"{contract_name}.sol/{contract_name}.json") as f:
        return json.load(f)["abi"]


def get_whitelisted_vaults() -> list[str]:
    """Fetch all whitelisted vault addresses from the OrionConfig contract."""
    CONFIG_ADDRESS = Web3.to_checksum_address(os.getenv("CONFIG_ADDRESS"))
    orion_config = w3.eth.contract(
        address=CONFIG_ADDRESS, abi=load_contract_abi("OrionConfig")
    )
    vault_count = orion_config.functions.whitelistVaultCount().call()
    vaults = []
    for i in range(vault_count):
        vault_address = orion_config.functions.getWhitelistedVaultAt(i).call()
        vaults.append(vault_address.lower())

    return vaults


def is_whitelisted(token_address: str) -> bool:
    """Check if a token address is whitelisted."""
    CONFIG_ADDRESS = Web3.to_checksum_address(os.getenv("CONFIG_ADDRESS"))
    orion_config = w3.eth.contract(
        address=CONFIG_ADDRESS, abi=load_contract_abi("OrionConfig")
    )
    return orion_config.functions.isWhitelisted(
        Web3.to_checksum_address(token_address)
    ).call()


def submit_order_intent(
    order_intent: dict,
    encoding: Literal[0, 1],  # 0=PLAINTEXT, 1=ENCRYPTED
) -> None:
    """Submit a portfolio order intent with PLAINTEXT or ENCRYPTED encoding."""
    account = w3.eth.account.from_key(os.getenv("CURATOR_PRIVATE_KEY"))
    nonce = w3.eth.get_transaction_count(account.address)

    items = [
        {"token": Web3.to_checksum_address(t), "amount": a}
        for t, a in order_intent.items()
    ]

    ORION_VAULT_ADDRESS = Web3.to_checksum_address(os.getenv("ORION_VAULT_ADDRESS"))
    contract = w3.eth.contract(
        address=ORION_VAULT_ADDRESS, abi=load_contract_abi("OrionVault")
    )

    # The dispatching is done in the sdk to enable explicit type definitions in the vault contract.
    if encoding == 0:
        func = contract.functions.submitOrderIntentPlain
    elif encoding == 1:
        # Encrypted amounts — amounts are expected to be already encoded as euint32 from TFHE
        breakpoint()
        # TODO: before bindings building, assess the compatibility of tenseal/tfhe-rs+py03 and fhevm-solidity.
        # TODO: int > euint32 > bytes.
        # py03 + https://github.com/zama-ai/tfhe-rs
        # items = [{"token": Web3.to_checksum_address(t), "amount": a} for t, a in order_intent.items()]
        func = contract.functions.submitOrderIntentEncrypted

    tx = func(items).build_transaction(
        {
            "from": account.address,
            "nonce": nonce,
            "gas": 500_000,
            "gasPrice": w3.eth.gas_price,
        }
    )

    signed = account.sign_transaction(tx)

    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    print("✅ Order submitted, tx hash:", tx_hash.hex())


def get_curator_intent_decimals() -> int:
    """Fetch the curator intent decimals from the OrionConfig contract."""
    CONFIG_ADDRESS = Web3.to_checksum_address(os.getenv("CONFIG_ADDRESS"))
    orion_config = w3.eth.contract(
        address=CONFIG_ADDRESS, abi=load_contract_abi("OrionConfig")
    )
    return orion_config.functions.curatorIntentDecimals().call()


def get_fhe_public_cid() -> str:
    """Fetch the FHE public CID from the OrionConfig contract."""
    CONFIG_ADDRESS = Web3.to_checksum_address(os.getenv("CONFIG_ADDRESS"))
    orion_config = w3.eth.contract(
        address=CONFIG_ADDRESS, abi=load_contract_abi("OrionConfig")
    )
    return orion_config.functions.fhePublicCID().call()
