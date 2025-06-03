"""Utils."""

import os
from pathlib import Path
from dotenv import load_dotenv
from lighthouseweb3 import Lighthouse

env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

def upload_and_get_url(file_path: str):
    """Upload content to Lighthouse and retrieves the url with content identifier (CID)."""
    lh = Lighthouse(os.getenv("LIGHTHOUSE_TOKEN"))

    try:
        response = lh.upload(file_path)
        cid = response["data"]["Hash"]
    except Exception:
        raise

    url = f"https://gateway.lighthouse.storage/ipfs/{cid}"
    return url, cid