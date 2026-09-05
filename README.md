# Trade Anomaly

USD/JPYの**時刻アノマリー（特定のJST時刻でエントリーし、一定時間保有）**を1時間足でスクリーニングする静的Webアプリです。

## Features

- USDJPY H1（Dukascopy bid OHLC）の直近約1年を自動取得
- JSTのEntry時刻 × Hold時間 × LONG/SHORTを総当たり
- Win rate / Avg return / per-trade Sharpe / trade count を表示
- 1M / 3M / 6M / 1Y / 任意日付範囲で再スクリーニング
- Entry時刻、Hold時間、方向、最小取引数、ランキング指標をUIで絞り込み
- 上位100戦略ランキング
- 戦略クリックで累積リターン曲線・個別統計を確認
- PCはテーブル、スマホはカード表示
- GitHub Actionsでデータ更新とGitHub Pagesデプロイ

## Method

各戦略はJSTで定義します。たとえば `Entry 23:00 / Hold 6h / LONG` は、23:00 JSTのH1バーの始値で入り、6時間後の05:00 JSTのH1バー始値で手仕舞う想定です。該当する終了時刻のバーが存在しないケース（週末など）はサンプルから除外します。

- LONG return = `exit_open / entry_open - 1`
- SHORT return = `-(exit_open / entry_open - 1)`
- Win% = return > 0 の比率
- AvgRet% = 1トレード当たり平均リターン
- Sharpe = `mean(return) / sample_std(return)`（非年率化・1トレード基準）

取引コスト・スリッページ・スワップは含みません。

## Data

データは `dukascopy-node` を使ってDukascopyのUSDJPY bid H1を取得します。初回は約1年、以後は直近7日を再取得してマージし、ローリング約1年を保持します。

## Local preview

静的サイトなので、リポジトリ直下をHTTPサーバーで配信すれば動作します。

```bash
python -m http.server 8000
```

データ更新はGitHub Actions（`.github/workflows/update-and-deploy.yml`）が担当します。

## GitHub Pages

公開先予定: https://protchan.github.io/Trade-Anomaly/

> 注意: このサイトは統計的探索・研究用です。多数の候補を同時に比較するため、上位結果にはデータスヌーピング／多重比較バイアスが含まれ得ます。将来収益を保証するものではありません。
