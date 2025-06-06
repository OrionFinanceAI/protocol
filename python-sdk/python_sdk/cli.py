import typer
from eth_abi import encode
from .ipfs import upload_to_ipfs, download_public_context  
from .fhe import run_keygen
from .chain_interactions import submit_order_intent, get_fhe_public_cid, get_whitelisted_vaults
from pathlib import Path
from dotenv import load_dotenv

app = typer.Typer()

env_path = Path(__file__).resolve().parent.parent.parent / ".env"
load_dotenv(dotenv_path=env_path)


# === Functions associated with protocol Deployer ===

@app.command()
def upload(path: str):
    """Upload a file to IPFS."""
    url, cid = upload_to_ipfs(path)
    print(f"Uploaded to IPFS: {url}")
    print(f"CID: {cid}")

@app.command()
def keygen():
    """Generate FHE keys."""
    run_keygen()

# === Functions associated with Curator ===

@app.command()
def download():
    """Download the public TenSEAL context from a given Lighthouse URL."""
    fhe_public_cid = get_fhe_public_cid()
    url = 'https://gateway.lighthouse.storage/ipfs/' + fhe_public_cid
    download_public_context(url)

@app.command()
def order_intent():
    """Submit an order intent."""
    whitelisted_vaults = get_whitelisted_vaults()
    tokens = whitelisted_vaults
    plaintext_amounts = [1000000000000000000] * len(tokens)
    encoding = 0 # PLAINTEXT

    fuzz = False # TODO: additionally, if fuzz call get_whitelisted_vaults and use random number generator with curator-set seed to populate additional entries with dust.
    if fuzz:
        breakpoint()

    # TODO: validate order before encoding.
    # TODO: values percentage of TVL (sum 1, long only, each bigger than 0)
    # TODO: (after encoding): FHE encrypted intents associated with protocol public FHE context.

    def encode_amount(amount_int, encoding):
        if encoding == 0:
            return encode(['uint256'], [amount_int])
        elif encoding == 1:
            breakpoint()
            # TODO: asked Zama if the following is good int > euint32 > bytes.
            # py03 + https://github.com/zama-ai/tfhe-rs
            # FheUint32::try_encrypt(clear_a, &client_key)?;

    amounts = [encode_amount(amount, encoding) for amount in plaintext_amounts]
    submit_order_intent(tokens=tokens, amounts=amounts, encoding=encoding)