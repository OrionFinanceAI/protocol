import typer
from .ipfs import upload_to_ipfs    
from .fhe import run_keygen

app = typer.Typer()

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


@app.command()
def download_public_context(url: str):
    """Download the public TenSEAL context from a given Lighthouse URL."""
    download_public_context(url)