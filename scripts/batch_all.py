"""
全国の市区町村データを順次取得・軽量化・R2アップロードするバッチ処理。
時間がかかる想定(全1965市区町村)。中断しても再実行で続きから処理される。

使い方:
    python scripts/batch_all.py                  # 全市区町村
    python scripts/batch_all.py --priority 38210,27109,24204  # 優先順位指定
"""
import argparse
import json
import shutil
import sys
import time
import traceback
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from pref_codes import PREF_CODES
from fetch_city import fetch_city, RAW_DIR
from build_city import build, PROCESSED_DIR
from upload_r2 import upload_city, get_client, BUCKET

ROOT = Path(__file__).parent.parent
STATE_PATH = ROOT / "data" / "batch_state.json"
LOG_PATH = ROOT / "data" / "batch_log.txt"
CKAN_BASE = "https://www.geospatial.jp/ckan/api/3/action"


def log(msg: str):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_state() -> dict:
    if STATE_PATH.exists():
        return json.loads(STATE_PATH.read_text(encoding="utf-8"))
    return {"done": {}, "failed": {}}


def save_state(state: dict):
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")


def list_all_cities() -> list[dict]:
    """CKANから aigid-moj-* の全データセットを取得し、citycode/pref/cityを返す"""
    results = []
    start = 0
    rows = 100
    while True:
        url = f"{CKAN_BASE}/package_search?fq=organization:aigid-moj-map&rows={rows}&start={start}"
        with urllib.request.urlopen(url, timeout=30) as resp:
            data = json.load(resp)["result"]
        for r in data["results"]:
            name = r["name"]  # aigid-moj-38210
            citycode = name.replace("aigid-moj-", "")
            pref = PREF_CODES.get(citycode[:2], "不明")
            # titleは "愛媛-伊予市" 形式。市区町村名部分を使う
            title_parts = r["title"].split("-", 1)
            city_name = title_parts[1] if len(title_parts) > 1 else r["title"]
            results.append({"citycode": citycode, "pref": pref, "city": city_name, "dataset": name})
        start += rows
        if start >= data["count"]:
            break
    return results


def load_manifest() -> dict:
    try:
        url = f"https://pub-2a294ad530454a6980cce69e465b09d8.r2.dev/manifest.json"
        with urllib.request.urlopen(url, timeout=15) as resp:
            return json.load(resp)
    except Exception:
        return {"cities": {}}


def upload_manifest(manifest: dict, client):
    import io
    body = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    client.put_object(Bucket=BUCKET, Key="manifest.json", Body=body, ContentType="application/json")


def process_city(entry: dict, client, manifest: dict) -> bool:
    citycode = entry["citycode"]
    try:
        log(f"[{citycode}] {entry['pref']}{entry['city']} 取得開始")
        raw_path = fetch_city(entry["dataset"])
        stem = raw_path.stem  # 例: 38210_2025
        log(f"[{citycode}] ダウンロード完了 ({raw_path.stat().st_size / 1e6:.1f} MB) ビルド中...")
        build(stem)
        log(f"[{citycode}] ビルド完了、R2アップロード中...")
        upload_city(citycode)

        manifest["cities"][citycode] = {"pref": entry["pref"], "city": entry["city"]}

        # ローカルのraw/processedは容量節約のため削除(R2とGoogleドライブに保存済み)
        raw_path.unlink(missing_ok=True)
        shutil.rmtree(PROCESSED_DIR / citycode, ignore_errors=True)

        log(f"[{citycode}] 完了")
        return True
    except Exception as e:
        log(f"[{citycode}] エラー: {e}\n{traceback.format_exc()}")
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--priority", default="", help="優先市区町村コード(カンマ区切り)")
    args = parser.parse_args()

    priority_codes = [c for c in args.priority.split(",") if c]

    log("全市区町村リストを取得中...")
    all_cities = list_all_cities()
    log(f"対象市区町村数: {len(all_cities)}")

    by_code = {c["citycode"]: c for c in all_cities}
    ordered = [by_code[c] for c in priority_codes if c in by_code]
    ordered += [c for c in all_cities if c["citycode"] not in priority_codes]

    state = load_state()
    client = get_client()
    manifest = load_manifest()

    total = len(ordered)
    for i, entry in enumerate(ordered, 1):
        citycode = entry["citycode"]
        if citycode in state["done"]:
            continue
        log(f"=== ({i}/{total}) {citycode} {entry['pref']}{entry['city']} ===")
        ok = process_city(entry, client, manifest)
        if ok:
            state["done"][citycode] = True
            state["failed"].pop(citycode, None)
        else:
            state["failed"][citycode] = True
        save_state(state)
        upload_manifest(manifest, client)  # 毎回更新(検索は各都市処理直後から使えるようにする)
        time.sleep(1)  # サーバーへの配慮

    log(f"バッチ処理完了。成功: {len(state['done'])}, 失敗: {len(state['failed'])}")


if __name__ == "__main__":
    main()
