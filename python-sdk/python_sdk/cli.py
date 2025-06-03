import typer
from .upload_to_ipfs import upload_and_get_url
from .fhe import run_keygen

app = typer.Typer()

@app.command()
def upload(path: str):
    """Upload a file to IPFS."""
    url, cid = upload_and_get_url(path)
    print(f"Uploaded to IPFS: {url}")
    print(f"CID: {cid}")

@app.command()
def keygen():
    """Generate FHE keys."""
    run_keygen()
