"""
data/raw/{citycode}_{year}.geojson を、大字ごとに分割・軽量化して
data/processed/{citycode}/ に出力する。

使い方:
    python scripts/build_city.py 38210_2025
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

RAW_DIR = Path(__file__).parent.parent / "data" / "raw"
PROCESSED_DIR = Path(__file__).parent.parent / "data" / "processed"

COORD_PRECISION = 7  # 小数点以下桁数(約1cm精度)
KEEP_PROPS = ["ID", "地番", "大字名", "市区町村名"]
UNKNOWN_OAZA = "不明"


def round_coords(coords):
    if isinstance(coords[0], (int, float)):
        return [round(c, COORD_PRECISION) for c in coords]
    return [round_coords(c) for c in coords]


def slim_feature(feat: dict) -> dict:
    props = feat["properties"]
    new_props = {k: props.get(k, "") for k in KEEP_PROPS}
    if not new_props["大字名"]:
        new_props["大字名"] = UNKNOWN_OAZA
    geom = feat["geometry"]
    return {
        "type": "Feature",
        "properties": new_props,
        "geometry": {
            "type": geom["type"],
            "coordinates": round_coords(geom["coordinates"]),
        },
    }


def bbox_of(features) -> list:
    xs, ys = [], []

    def walk(coords):
        if isinstance(coords[0], (int, float)):
            xs.append(coords[0])
            ys.append(coords[1])
        else:
            for c in coords:
                walk(c)

    for f in features:
        walk(f["geometry"]["coordinates"])
    return [min(xs), min(ys), max(xs), max(ys)]


def build(stem: str):
    raw_path = RAW_DIR / f"{stem}.geojson"
    m = re.match(r"(\d{5})_(\d{4})", stem)
    if not m:
        raise SystemExit(f"ファイル名 '{stem}' から市区町村コードを取得できません")
    citycode, year = m.group(1), m.group(2)

    print(f"読み込み中: {raw_path}")
    with open(raw_path, encoding="utf-8") as f:
        data = json.load(f)

    by_oaza: dict[str, list] = defaultdict(list)
    city_name = ""
    for feat in data["features"]:
        slim = slim_feature(feat)
        by_oaza[slim["properties"]["大字名"]].append(slim)
        if not city_name and feat["properties"].get("市区町村名"):
            city_name = feat["properties"]["市区町村名"]

    out_dir = PROCESSED_DIR / citycode
    out_dir.mkdir(parents=True, exist_ok=True)

    index = {"citycode": citycode, "city": city_name, "year": year, "oaza": []}
    total_size = 0
    for oaza_name, features in sorted(by_oaza.items(), key=lambda x: -len(x[1])):
        fc = {"type": "FeatureCollection", "features": features}
        out_path = out_dir / f"{oaza_name}.geojson"
        text = json.dumps(fc, ensure_ascii=False, separators=(",", ":"))
        out_path.write_text(text, encoding="utf-8")
        size = out_path.stat().st_size
        total_size += size
        index["oaza"].append({
            "name": oaza_name,
            "file": out_path.name,
            "count": len(features),
            "bbox": bbox_of(features),
            "size": size,
        })
        print(f"  {oaza_name}: {len(features)}筆, {size / 1e3:.0f} KB")

    index_path = out_dir / "index.json"
    index_path.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"\n完了: {out_dir}")
    print(f"大字数: {len(by_oaza)}, 合計サイズ: {total_size / 1e6:.1f} MB (元: {raw_path.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("使い方: python scripts/build_city.py <citycode>_<year>")
    build(sys.argv[1])
