# Trade Anomaly

USD/JPYの**時刻アノマリー（特定のJST時刻でエントリーし、一定時間保有）**を1時間足でスクリーニングし、さらに「そのアノマリーがいつ・どの市場状態で再現するか」を診断する静的Webアプリです。

## Features

### Screener

- USDJPY H1（Dukascopy Bid/Ask → midpoint）の長期履歴を自動取得
- JSTのEntry時刻 × Hold時間 × LONG/SHORTを総当たり
- Win rate / Avg return / per-trade Sharpe / trade count を表示
- 1M / 3M / 6M / 1Y / 3Y / 5Y / 10Y / 任意日付範囲で再スクリーニング
- Entry時刻、Hold時間、方向、最小取引数、ランキング指標をUIで絞り込み
- 上位100戦略ランキング
- 戦略クリックで累積リターン曲線・個別統計を確認

### Anomaly Essence Lab

`research.html` では、PnL最大化よりもアノマリーの再現性を調べます。

- 月別edge strengthと年別安定性
- 過去年だけで方向を決め、翌年を評価するyear walk-forward
- 記述的なmean-shift change-point候補
- entry時点で既知の状態変数による条件付きedge
  - rolling volatility
  - previous-hour activity / rolling median
  - 10-pip round-number distance
  - 24h trend
- 月次効果を「state compositionで説明される部分」と「structural residual」に分解
- heuristic robustness scoreで安定候補を並べるが、正式なOOS発見確率とは扱わない

## Method

各戦略はJSTで定義します。たとえば `Entry 23:00 / Hold 6h / LONG` は、23:00 JSTのH1バーの始値で入り、6時間後の05:00 JSTのH1バー始値で手仕舞う想定です。該当する終了時刻のバーが存在しないケース（週末など）はサンプルから除外します。

- LONG return = `exit_open / entry_open - 1`
- SHORT return = `-(exit_open / entry_open - 1)`
- Win% = return > 0 の比率
- AvgRet = 1トレード当たり平均リターン
- Sharpe = `mean(return) / sample_std(return)`（非年率化・1トレード基準）

研究ページのfull-sample directionは、効果の符号を読みやすくするため全期間平均の向きへ揃えています。そのためそれ自体はuntouched OOSではありません。より重視する診断は、前年までのデータだけで方向を決めて次年を評価するwalk-forwardです。

取引コスト・スリッページ・スワップは含みません。

## Data

データは `dukascopy-go` を使ってDukascopyのUSDJPY Bid/Ask H1を取得し、midpointへ変換します。長期H1を保持しつつ、直近7日はBid/Ask M1から再集約して更新します。

GitHub Actionsの各更新で以下を生成します。

- `data/usdjpy_h1.csv` — long-history midpoint H1
- `data/meta.json` — dataset metadata
- `data/anomaly_research.json` — temporal/regime anomaly diagnostics

## Local preview

静的サイトなので、リポジトリ直下をHTTPサーバーで配信すれば動作します。

```bash
python -m http.server 8000
```

研究JSONの再生成:

```bash
python scripts/analyze_anomaly.py --input data/usdjpy_h1.csv --output data/anomaly_research.json
```

データ更新はGitHub Actions（`.github/workflows/update-and-deploy.yml`）が担当します。

## GitHub Pages

- Screener: https://protchan.github.io/Trade-Anomaly/
- Anomaly Essence Lab: https://protchan.github.io/Trade-Anomaly/research.html

> 注意: このサイトは統計的探索・研究用です。多数の候補を同時に比較するため、上位結果にはデータスヌーピング／多重比較バイアスが含まれ得ます。変化点やrobustness scoreも記述的診断であり、将来収益を保証するものではありません。
