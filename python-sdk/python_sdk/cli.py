"""Command line interface for the Orion Python SDK."""

from pathlib import Path

import pandas as pd
import typer
from dotenv import load_dotenv

from .chain_interactions import get_fhe_public_cid, submit_order_intent
from .fhe import run_keygen
from .ipfs import download_public_context, upload_to_ipfs
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
    url = "https://gateway.lighthouse.storage/ipfs/" + fhe_public_cid
    download_public_context(url)


@app.command()
def order_intent(
    portfolio_path: str = typer.Option(..., help="Path to the portfolio parquet file"),
    encoding: int = typer.Option(0, help="Encoding type: 0=PLAINTEXT, 1=ENCRYPTED"),
) -> None:
    """Submit an order intent."""
    df = pd.read_parquet(portfolio_path)

    order_intent = df.iloc[-1]
    order_intent = order_intent[order_intent != 0]

    # TODO: specific of current curator portfolio management pipeline.
    # Sdk shall be agnostic of the portfolio management pipeline.
    order_intent.index = order_intent.index.str.lower().str.replace(
        "_1", "", regex=False
    )

    order_intent_dict = order_intent.to_dict()
    validated_order_intent = validate_order(order_intent=order_intent_dict, fuzz=False)

    submit_order_intent(order_intent=validated_order_intent, encoding=encoding)
