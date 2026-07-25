"""
data/processed/{citycode}/ の中身をCloudflare R2にアップロードする。

使い方:
    python scripts/upload_r2.py 38210
"""
import os
import sys
from pathlib import Path

import boto3
from dotenv import load_dotenv

ROOT = Path(__file__).parent.parent
load_dotenv(ROOT / ".env")

BUCKET = "chiban-map-data"
PROCESSED_DIR = ROOT / "data" / "processed"


def get_client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["CF_R2_ENDPOINT"],
        aws_access_key_id=os.environ["CF_R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["CF_R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def upload_city(citycode: str):
    city_dir = PROCESSED_DIR / citycode
    if not city_dir.exists():
        raise SystemExit(f"{city_dir} が見つかりません。先に build_city.py を実行してください")

    client = get_client()
    files = list(city_dir.glob("*.geojson")) + list(city_dir.glob("index.json"))
    for path in files:
        key = f"{citycode}/{path.name}"
        client.upload_file(
            str(path),
            BUCKET,
            key,
            ExtraArgs={"ContentType": "application/json"},
        )
        print(f"  uploaded: {key} ({path.stat().st_size / 1e3:.0f} KB)")

    print(f"完了: {len(files)} ファイルを {BUCKET}/{citycode}/ にアップロードしました")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("使い方: python scripts/upload_r2.py <citycode>")
    upload_city(sys.argv[1])
