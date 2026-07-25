# chiban-map

住所・地番を入力すると地図上の該当する筆（区画）をハイライト表示するWebサイト。複数の住所を同時にハイライトでき、印刷/PDF出力にも対応。

法務省が公開する「登記所備付地図データ」（G空間情報センター経由でGeoJSON変換済み）を元に、市区町村ごとに軽量化したデータをCloudflare R2で配信する。

## 構成

```
site/       静的サイト本体 (Leaflet + 地理院タイル)。GitHub Pagesで公開
scripts/    データ取得・加工・配信用スクリプト
data/       ローカル作業用データ(gitには含めない)
```

## 新しい市区町村を追加する手順

```bash
pip install -r requirements.txt

# 1. G空間情報センターからGeoJSONを取得(市区町村コード or 名前検索)
python scripts/fetch_city.py 38210
python scripts/fetch_city.py --search 伊予市

# 2. 大字ごとに分割・軽量化
python scripts/build_city.py 38210_2025

# 3. Cloudflare R2にアップロード
python scripts/upload_r2.py 38210
```

`.env` に以下を設定しておく(リポジトリには含めない):

```
GSPATIAL_API_TOKEN=...
CF_API_TOKEN=...
CF_ACCOUNT_ID=...
CF_R2_ACCESS_KEY_ID=...
CF_R2_SECRET_ACCESS_KEY=...
CF_R2_ENDPOINT=...
```

生データはGoogleドライブ同期フォルダ (`G:\マイドライブ\chiban-map_生データ`) にも自動バックアップされる。

サイト側で表示する市区町村は `site/config.js` の `DEFAULT_CITY` を切り替える。
