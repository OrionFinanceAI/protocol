import typer
from eth_abi import encode
from .ipfs import upload_to_ipfs, download_public_context  
from .fhe import run_keygen
from .chain_interactions import submit_order_intent, get_fhe_public_cid, get_whitelisted_vaults
from pathlib import Path
from dotenv import load_dotenv
from .validation import validate_order

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
    tokens = ['0x0692d38F0da545D08d5101aC09AA4139D121F127', '0x3d99435E5531b47267739755D7c91332a0304905']
    amounts = [100, 200] # [0.6, 0.4] # TODO: contract expects integers, pct of TVL necessarily float. Define conversion function.
    encoding = 0 # PLAINTEXT

    fuzz = False # TODO: if fuzz call get_whitelisted_vaults() and use random number generator with curator-set seed to populate additional entries with dust.
    if fuzz:
        breakpoint()
    
    submit_order_intent(tokens=tokens, amounts=amounts, encoding=encoding)