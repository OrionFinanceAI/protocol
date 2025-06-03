"""Utils."""

import os
from pathlib import Path
from dotenv import load_dotenv
from lighthouseweb3 import Lighthouse
import requests

env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

def upload_to_ipfs(file_path: str):
    """Upload content to Lighthouse and retrieves the url with content identifier (CID)."""
    lh = Lighthouse(os.getenv("LIGHTHOUSE_TOKEN"))

    try:
        response = lh.upload(file_path)
        cid = response["data"]["Hash"]
    except Exception:
        raise

    url = f"https://gateway.lighthouse.storage/ipfs/{cid}"
    return url, cid

def download_public_context(url: str, output_path: str = "context.public.tenseal"):
    """Download the public TenSEAL context from a given Lighthouse URL."""
    response = requests.get(url)
    response.raise_for_status()
    with open(output_path, "wb") as f:
        f.write(response.content)
    print("✅ Public context downloaded.")
    return output_path