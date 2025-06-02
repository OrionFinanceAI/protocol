"""Utils."""

import os
from dotenv import load_dotenv
from lighthouseweb3 import Lighthouse

load_dotenv()

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

if __name__ == "__main__":
    url, cid = upload_and_get_url("fhe-keys/fhePublicKeyHex.hex")
    print(url)
    print(cid)