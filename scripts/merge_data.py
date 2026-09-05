#!/usr/bin/env python3
"""Merge one or more Dukascopy full bid/ask H1 CSVs into a rolling midpoint dataset."""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path

DAY_MS = 86_400_000
KEEP_DAYS = 365
DATASET_VERSION = 2
FIELDS = ("timestamp", "open", "high", "low", "close", "volume")


def parse_ts(value: str | None) -> int:
    if value is None:
        raise ValueError("missing timestamp")
    s = str(value).strip()
    try:
        n = float(s)
        if n > 10_000_000_000:
            return int(n)
        if n > 1_000_000_000:
            return int(n * 1000)
    except ValueError:
        pass
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def num(value: str | None, default: float = 0.0) -> float:
    try:
        return float(value) if value not in (None, "") else default
    except (TypeError, ValueError):
        return default


def load_existing(path: Path) -> dict[int, dict[str, float | int]]:
    out: dict[int, dict[str, float | int]] = {}
    if not path.exists() or path.stat().st_size == 0:
        return out
    with path.open("r", newline="", encoding="utf-8-sig") as f:
        for raw in csv.DictReader(f):
            try:
                ts = parse_ts(raw.get("timestamp"))
                row = {
                    "timestamp": ts,
                    "open": float(raw["open"]),
                    "high": float(raw["high"]),
                    "low": float(raw["low"]),
                    "close": float(raw["close"]),
                    "volume": num(raw.get("volume"), 0.0),
                }
            except (KeyError, TypeError, ValueError):
                continue
            if min(float(row[k]) for k in ("open", "high", "low", "close")) <= 0:
                continue
            out[ts] = row
    return out


def load_full(path: Path) -> tuple[dict[int, dict[str, float | int]], list[float]]:
    if not path.exists() or path.stat().st_size == 0:
        raise SystemExit(f"Full bid/ask CSV missing or empty: {path}")
    out: dict[int, dict[str, float | int]] = {}
    spreads: list[float] = []
    with path.open("r", newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        cols = {c.strip().lower() for c in (reader.fieldnames or [])}
        required = {"timestamp", "mid_open", "mid_high", "mid_low", "mid_close"}
        missing = required - cols
        if missing:
            raise SystemExit(f"Full CSV is missing required midpoint columns: {sorted(missing)}; got {sorted(cols)}")
        for raw0 in reader:
            raw = {str(k).strip().lower(): v for k, v in raw0.items()}
            try:
                ts = parse_ts(raw.get("timestamp"))
                o = float(raw["mid_open"])
                h = float(raw["mid_high"])
                l = float(raw["mid_low"])
                c = float(raw["mid_close"])
            except (TypeError, ValueError, KeyError):
                continue
            if min(o, h, l, c) <= 0 or h < max(o, c) or l > min(o, c) or h < l:
                continue
            out[ts] = {
                "timestamp": ts,
                "open": o,
                "high": h,
                "low": l,
                "close": c,
                "volume": num(raw.get("volume"), 0.0),
            }
            spread = num(raw.get("spread"), -1.0)
            if spread >= 0:
                spreads.append(spread)
    if not out:
        raise SystemExit(f"No valid midpoint rows found in full bid/ask CSV: {path}")
    return out, spreads


def iso(ts: int) -> str:
    return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--full-file", action="append", required=True, help="Repeat for additional full quote CSVs; later files override matching timestamps")
    ap.add_argument("--output", default="data/usdjpy_h1.csv")
    ap.add_argument("--meta", default="data/meta.json")
    ap.add_argument("--reset-existing", action="store_true")
    args = ap.parse_args()

    output = Path(args.output)
    meta = Path(args.meta)
    output.parent.mkdir(parents=True, exist_ok=True)

    merged = {} if args.reset_existing else load_existing(output)
    all_spreads: list[float] = []
    fresh_count = 0
    sources: list[str] = []
    for filename in args.full_file:
        path = Path(filename)
        fresh, spreads = load_full(path)
        merged.update(fresh)
        fresh_count += len(fresh)
        all_spreads.extend(spreads)
        sources.append(path.name)

    if not merged:
        raise SystemExit("No midpoint rows available after merge")

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

    info = {
        "dataset_version": DATASET_VERSION,
        "symbol": "USDJPY",
        "timeframe": "H1",
        "price_type": "mid",
        "mid_method": "Dukascopy full quote bars; fieldwise midpoint = (bid + ask) / 2; screener entry/exit uses mid_open",
        "timezone_source": "UTC",
        "display_timezone": "Asia/Tokyo (JST, UTC+9)",
        "source": "Dukascopy full Bid+Ask H1 → Mid",
        "source_files_this_run": sources,
        "bars": len(rows),
        "first_timestamp": int(rows[0]["timestamp"]),
        "last_timestamp": int(rows[-1]["timestamp"]),
        "first_utc": iso(int(rows[0]["timestamp"])),
        "last_utc": iso(int(rows[-1]["timestamp"])),
        "generated_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "mid_rows_loaded_this_run": fresh_count,
        "mean_spread_jpy_this_run": (sum(all_spreads) / len(all_spreads)) if all_spreads else None,
        "max_spread_jpy_this_run": max(all_spreads) if all_spreads else None,
        "rolling_days": KEEP_DAYS,
    }
    meta.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(info, ensure_ascii=False))


if __name__ == "__main__":
    main()
