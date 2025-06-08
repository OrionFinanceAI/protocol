import typer
from .ipfs import upload_to_ipfs, download_public_context  
from .fhe import run_keygen
from .chain_interactions import submit_order_intent, get_fhe_public_cid
from pathlib import Path
from dotenv import load_dotenv
from .utils import validate_order

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

    # Curator submitting order intent as percentage of TVL.
    tokens = ['0x3d99435E5531b47267739755D7c91332a0304905']
    amounts = [1]
    
    encoding = 0 # PLAINTEXT

    tokens, amounts = validate_order(tokens=tokens, amounts=amounts, fuzz=True)
    submit_order_intent(tokens=tokens, amounts=amounts, encoding=encoding)