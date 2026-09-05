#!/usr/bin/env python3
"""Build rolling USDJPY H1 mid candles from matched Dukascopy bid/ask H1 CSVs."""

from __future__ import annotations

import argparse
import csv
import glob
import json
from datetime import datetime, timezone
from pathlib import Path

DAY_MS = 86_400_000
KEEP_DAYS = 365
FIELDS = ("timestamp", "open", "high", "low", "close", "volume")


def parse_num(value: str | None, default: float = 0.0) -> float:
    try:
        return float(value) if value not in (None, "") else default
    except (TypeError, ValueError):
        return default


def normalize_row(row: dict[str, str]) -> dict[str, float | int] | None:
    keys = {str(k).strip().lower(): v for k, v in row.items()}
    try:
        ts = int(float(keys.get("timestamp", "")))
        o = float(keys.get("open", ""))
        h = float(keys.get("high", ""))
        l = float(keys.get("low", ""))
        c = float(keys.get("close", ""))
    except (TypeError, ValueError):
        return None
    if ts < 1_000_000_000_000 or min(o, h, l, c) <= 0:
        return None
    if h < max(o, c) or l > min(o, c) or h < l:
        return None
    return {
        "timestamp": ts,
        "open": o,
        "high": h,
        "low": l,
        "close": c,
        "volume": parse_num(keys.get("volume"), 0.0),
    }


def load_csv(path: Path) -> list[dict[str, float | int]]:
    if not path.exists() or path.stat().st_size == 0:
        return []
    rows: list[dict[str, float | int]] = []
    with path.open("r", newline="", encoding="utf-8-sig") as f:
        for raw in csv.DictReader(f):
            row = normalize_row(raw)
            if row:
                rows.append(row)
    return rows


def load_tree(directory: str) -> dict[int, dict[str, float | int]]:
    files = sorted(Path(p) for p in glob.glob(str(Path(directory) / "**" / "*.csv"), recursive=True))
    if not files:
        raise SystemExit(f"No downloaded CSV files found under {directory}")
    out: dict[int, dict[str, float | int]] = {}
    for path in files:
        for row in load_csv(path):
            out[int(row["timestamp"])] = row
    return out


def make_mid(bid: dict[str, float | int], ask: dict[str, float | int]) -> dict[str, float | int]:
    # Screening uses OPEN only. Open/close are exact quote-side midpoints at the H1 boundary.
    # High/low are component-wise H1 bid/ask midpoint approximations because source-side
    # H1 extrema need not occur at the exact same intra-hour tick.
    return {
        "timestamp": int(bid["timestamp"]),
        "open": (float(bid["open"]) + float(ask["open"])) / 2.0,
        "high": (float(bid["high"]) + float(ask["high"])) / 2.0,
        "low": (float(bid["low"]) + float(ask["low"])) / 2.0,
        "close": (float(bid["close"]) + float(ask["close"])) / 2.0,
        "volume": (float(bid.get("volume", 0.0)) + float(ask.get("volume", 0.0))) / 2.0,
    }


def iso(ts: int) -> str:
    return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bid-dir", default="download/bid")
    ap.add_argument("--ask-dir", default="download/ask")
    ap.add_argument("--output", default="data/usdjpy_h1.csv")
    ap.add_argument("--meta", default="data/meta.json")
    ap.add_argument("--reset-existing", action="store_true")
    args = ap.parse_args()

    output = Path(args.output)
    meta = Path(args.meta)
    output.parent.mkdir(parents=True, exist_ok=True)

    merged: dict[int, dict[str, float | int]] = {}
    if not args.reset_existing:
        for row in load_csv(output):
            merged[int(row["timestamp"])] = row

    bids = load_tree(args.bid_dir)
    asks = load_tree(args.ask_dir)
    matched = sorted(set(bids).intersection(asks))
    if not matched:
        raise SystemExit("No matched bid/ask H1 timestamps")

    for ts in matched:
        merged[ts] = make_mid(bids[ts], asks[ts])

    if not merged:
        raise SystemExit("No valid H1 mid rows after merge")

    latest = max(merged)
    cutoff = latest - KEEP_DAYS * DAY_MS
    rows = [merged[k] for k in sorted(merged) if cutoff <= k <= latest and k % 3_600_000 == 0]
    if len(rows) < 4_000:
        raise SystemExit(f"Refusing to publish suspiciously short dataset: {len(rows)} rows")

    with output.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        for row in rows:
            writer.writerow({k: row[k] for k in FIELDS})

    spreads = [float(asks[ts]["open"]) - float(bids[ts]["open"]) for ts in matched]
    info = {
        "symbol": "USDJPY",
        "timeframe": "H1",
        "price_type": "mid",
        "mid_method": "fieldwise (bid + ask) / 2; screener entry/exit uses mid open",
        "timezone_source": "UTC",
        "display_timezone": "Asia/Tokyo (JST, UTC+9)",
        "source": "Dukascopy bid+ask H1 → mid",
        "bars": len(rows),
        "first_timestamp": int(rows[0]["timestamp"]),
        "last_timestamp": int(rows[-1]["timestamp"]),
        "first_utc": iso(int(rows[0]["timestamp"])),
        "last_utc": iso(int(rows[-1]["timestamp"])),
        "generated_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "matched_bid_ask_rows_this_run": len(matched),
        "mean_open_spread_jpy_this_run": sum(spreads) / len(spreads),
        "max_open_spread_jpy_this_run": max(spreads),
        "rolling_days": KEEP_DAYS,
    }
    meta.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(info, ensure_ascii=False))


if __name__ == "__main__":
    main()
