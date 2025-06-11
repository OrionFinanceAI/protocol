import typer
from .ipfs import upload_to_ipfs, download_public_context  
from .fhe import run_keygen
from .chain_interactions import submit_order_intent, get_fhe_public_cid
from pathlib import Path
from dotenv import load_dotenv
from .utils import validate_order
import pandas as pd

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

    df = pd.read_parquet('../../portfolio-manager/output/optimized/1.parquet')

    order_intent = df.iloc[-1]
        
    order_intent = order_intent[order_intent != 0]

    order_intent.index = order_intent.index.str.lower().str.replace('_1', '', regex=False)

    order_intent = order_intent.to_dict()

    encoding = 0 # PLAINTEXT

    order_intent = validate_order(order_intent=order_intent, fuzz=False)

    submit_order_intent(order_intent=order_intent, encoding=encoding)