"""
G空間情報センター(CKAN)から市区町村の登記所備付地図データ(変換済GeoJSON)を取得する。

使い方:
    python scripts/fetch_city.py 38210          # 市区町村コード指定
    python scripts/fetch_city.py --search 伊予市  # 名前で検索

取得したファイルは data/raw/{citycode}_{年}.geojson に保存し、
Googleドライブの同期フォルダにもバックアップコピーする。
"""
import argparse
import json
import os
import shutil
import sys
import urllib.parse
import urllib.request
from pathlib import Path

CKAN_BASE = "https://www.geospatial.jp/ckan/api/3/action"
ORG_NAME = "aigid-moj-map"  # 法務省登記所備付地図データ変換済
RAW_DIR = Path(__file__).parent.parent / "data" / "raw"
GDRIVE_BACKUP_DIR = Path("G:/マイドライブ/chiban-map_生データ")


def api_get(action: str, **params) -> dict:
    qs = "&".join(f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items())
    url = f"{CKAN_BASE}/{action}?{qs}"
    with urllib.request.urlopen(url, timeout=30) as resp:
        data = json.load(resp)
    if not data.get("success"):
        raise RuntimeError(f"CKAN API error: {data}")
    return data["result"]


def search_city(keyword: str) -> str:
    """市区町村名から aigid-moj-{code} のデータセット名を探す"""
    result = api_get("package_search", q=keyword, fq=f"organization:{ORG_NAME}", rows=10)
    if result["count"] == 0:
        raise SystemExit(f"'{keyword}' に一致するデータセットが見つかりませんでした")
    if result["count"] > 1:
        print(f"複数候補が見つかりました:", file=sys.stderr)
        for r in result["results"]:
            print(f"  - {r['title']} ({r['name']})", file=sys.stderr)
        print("最初の候補を使用します。", file=sys.stderr)
    return result["results"][0]["name"]


def fetch_city(dataset_name: str) -> Path:
    pkg = api_get("package_show", id=dataset_name)
    geojson_resources = [r for r in pkg["resources"] if r["format"] == "GeoJSON"]
    if not geojson_resources:
        raise SystemExit(f"{dataset_name} にGeoJSONリソースが見つかりません")

    # ファイル名の年(_r_YYYY.geojson)で最新を選ぶ
    def year_of(res):
        name = res["name"]
        import re
        m = re.search(r"_(\d{4})\.geojson$", name)
        return int(m.group(1)) if m else 0

    latest = max(geojson_resources, key=year_of)
    citycode = dataset_name.replace("aigid-moj-", "")
    year = year_of(latest)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    out_path = RAW_DIR / f"{citycode}_{year}.geojson"

    print(f"ダウンロード中: {latest['name']} ({latest['size'] / 1e6:.1f} MB) -> {out_path}")
    urllib.request.urlretrieve(latest["url"], out_path)

    if GDRIVE_BACKUP_DIR.exists():
        backup_path = GDRIVE_BACKUP_DIR / out_path.name
        shutil.copy2(out_path, backup_path)
        print(f"Googleドライブにバックアップしました: {backup_path}")
    else:
        print(f"注意: Googleドライブフォルダが見つかりません ({GDRIVE_BACKUP_DIR})。バックアップはスキップされました。", file=sys.stderr)

    return out_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("target", help="市区町村コード(例:38210) または --search 併用時はキーワード")
    parser.add_argument("--search", action="store_true", help="targetを市区町村名として検索する")
    args = parser.parse_args()

    if args.search:
        dataset_name = search_city(args.target)
    else:
        dataset_name = f"aigid-moj-{args.target}"

    fetch_city(dataset_name)
