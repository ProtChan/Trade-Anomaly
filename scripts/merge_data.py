#!/usr/bin/env python3
"""Build a rolling USDJPY H1 midpoint dataset from Dukascopy full quote bars, M1 bars, or ticks."""

from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path

DAY_MS = 86_400_000
HOUR_MS = 3_600_000
KEEP_DAYS = 365
DATASET_VERSION = 4
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
                row = {"timestamp": ts, "open": float(raw["open"]), "high": float(raw["high"]), "low": float(raw["low"]), "close": float(raw["close"]), "volume": num(raw.get("volume"), 0.0)}
            except (KeyError, TypeError, ValueError):
                continue
            if min(float(row[k]) for k in ("open", "high", "low", "close")) > 0:
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
                ts = parse_ts(raw.get("timestamp")); o = float(raw["mid_open"]); h = float(raw["mid_high"]); l = float(raw["mid_low"]); c = float(raw["mid_close"])
            except (TypeError, ValueError, KeyError):
                continue
            if min(o, h, l, c) <= 0 or h < max(o, c) or l > min(o, c) or h < l:
                continue
            out[ts] = {"timestamp": ts, "open": o, "high": h, "low": l, "close": c, "volume": num(raw.get("volume"), 0.0)}
            spread = num(raw.get("spread"), -1.0)
            if spread >= 0:
                spreads.append(spread)
    if not out:
        raise SystemExit(f"No valid midpoint rows found in full bid/ask CSV: {path}")
    return out, spreads


def aggregate_rows_to_h1(rows: dict[int, dict[str, float | int]]) -> dict[int, dict[str, float | int]]:
    bars: dict[int, dict[str, float | int]] = {}
    for ts in sorted(rows):
        src = rows[ts]
        hour = ts - ts % HOUR_MS
        if hour not in bars:
            bars[hour] = {"timestamp": hour, "open": float(src["open"]), "high": float(src["high"]), "low": float(src["low"]), "close": float(src["close"]), "volume": float(src["volume"])}
        else:
            bar = bars[hour]
            bar["high"] = max(float(bar["high"]), float(src["high"]))
            bar["low"] = min(float(bar["low"]), float(src["low"]))
            bar["close"] = float(src["close"])
            bar["volume"] = float(bar["volume"]) + float(src["volume"])
    return bars


def load_m1(path: Path) -> tuple[dict[int, dict[str, float | int]], list[float], int]:
    minute_rows, spreads = load_full(path)
    bars = aggregate_rows_to_h1(minute_rows)
    return bars, spreads, len(minute_rows)


def load_ticks(path: Path) -> tuple[dict[int, dict[str, float | int]], list[float], int]:
    if not path.exists() or path.stat().st_size == 0:
        raise SystemExit(f"Tick CSV missing or empty: {path}")
    bars: dict[int, dict[str, float | int]] = {}
    last_tick_ts: dict[int, int] = {}
    spreads: list[float] = []
    tick_count = 0
    with path.open("r", newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        cols = {c.strip().lower() for c in (reader.fieldnames or [])}
        required = {"timestamp", "bid", "ask"}
        missing = required - cols
        if missing:
            raise SystemExit(f"Tick CSV is missing required columns: {sorted(missing)}; got {sorted(cols)}")
        for raw0 in reader:
            raw = {str(k).strip().lower(): v for k, v in raw0.items()}
            try:
                ts = parse_ts(raw.get("timestamp")); bid = float(raw["bid"]); ask = float(raw["ask"])
            except (TypeError, ValueError, KeyError):
                continue
            if bid <= 0 or ask <= 0 or ask < bid:
                continue
            mid = (bid + ask) / 2.0; hour = ts - ts % HOUR_MS
            volume = num(raw.get("bid_volume"), 0.0) + num(raw.get("ask_volume"), 0.0)
            tick_count += 1; spreads.append(ask - bid)
            if hour not in bars:
                bars[hour] = {"timestamp": hour, "open": mid, "high": mid, "low": mid, "close": mid, "volume": volume}; last_tick_ts[hour] = ts
            else:
                bar = bars[hour]; bar["high"] = max(float(bar["high"]), mid); bar["low"] = min(float(bar["low"]), mid); bar["volume"] = float(bar["volume"]) + volume
                if ts >= last_tick_ts[hour]:
                    bar["close"] = mid; last_tick_ts[hour] = ts
    if not bars:
        raise SystemExit(f"No valid midpoint H1 rows could be aggregated from ticks: {path}")
    return bars, spreads, tick_count


def iso(ts: int) -> str:
    return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--full-file", action="append", default=[], help="Dukascopy full Bid/Ask H1 CSV")
    ap.add_argument("--m1-file", action="append", default=[], help="Dukascopy full Bid/Ask M1 CSV; aggregated to H1 and overrides matching hours")
    ap.add_argument("--tick-file", action="append", default=[], help="Dukascopy Bid/Ask tick CSV; aggregated to H1 and overrides matching hours")
    ap.add_argument("--output", default="data/usdjpy_h1.csv")
    ap.add_argument("--meta", default="data/meta.json")
    ap.add_argument("--reset-existing", action="store_true")
    args = ap.parse_args()
    if not args.full_file and not args.m1_file and not args.tick_file:
        raise SystemExit("At least one source file is required")

    output = Path(args.output); meta = Path(args.meta); output.parent.mkdir(parents=True, exist_ok=True)
    merged = {} if args.reset_existing else load_existing(output)
    all_spreads: list[float] = []; fresh_count = 0; raw_tick_count = 0; minute_count = 0
    sources: list[str] = []; m1_sources: list[str] = []; tick_sources: list[str] = []

    for filename in args.full_file:
        path = Path(filename); fresh, spreads = load_full(path); merged.update(fresh); fresh_count += len(fresh); all_spreads.extend(spreads); sources.append(path.name)
    for filename in args.m1_file:
        path = Path(filename); fresh, spreads, minutes = load_m1(path); merged.update(fresh); fresh_count += len(fresh); minute_count += minutes; all_spreads.extend(spreads); m1_sources.append(path.name); sources.append(path.name)
    for filename in args.tick_file:
        path = Path(filename); fresh, spreads, ticks = load_ticks(path); merged.update(fresh); fresh_count += len(fresh); raw_tick_count += ticks; all_spreads.extend(spreads); tick_sources.append(path.name); sources.append(path.name)

    if not merged:
        raise SystemExit("No midpoint rows available after merge")
    latest = max(merged); cutoff = latest - KEEP_DAYS * DAY_MS
    rows = [merged[k] for k in sorted(merged) if cutoff <= k <= latest and k % HOUR_MS == 0]
    if len(rows) < 4_000:
        raise SystemExit(f"Refusing to publish suspiciously short dataset: {len(rows)} rows")

    with output.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS, lineterminator="\n"); writer.writeheader()
        for row in rows:
            writer.writerow({k: row[k] for k in FIELDS})

    if tick_sources:
        source = "Dukascopy H1 + recent raw Bid/Ask ticks → Mid H1"
        method = "Historical H1 uses full quote midpoint; recent H1 is aggregated from raw ticks with mid=(bid+ask)/2 per tick; screener uses mid_open"
    elif m1_sources:
        source = "Dukascopy H1 + recent full Bid/Ask M1 → Mid H1"
        method = "Historical H1 uses full quote midpoint; recent direct-datafeed M1 uses bid/ask midpoint columns and is aggregated to UTC H1; screener uses H1 mid_open"
    else:
        source = "Dukascopy full Bid+Ask H1 → Mid"
        method = "Dukascopy full quote bars; fieldwise midpoint=(bid+ask)/2; screener uses mid_open"

    info = {
        "dataset_version": DATASET_VERSION, "symbol": "USDJPY", "timeframe": "H1", "price_type": "mid", "mid_method": method,
        "timezone_source": "UTC", "display_timezone": "Asia/Tokyo (JST, UTC+9)", "source": source,
        "source_files_this_run": sources, "m1_sources_this_run": m1_sources, "tick_sources_this_run": tick_sources,
        "bars": len(rows), "first_timestamp": int(rows[0]["timestamp"]), "last_timestamp": int(rows[-1]["timestamp"]),
        "first_utc": iso(int(rows[0]["timestamp"])), "last_utc": iso(int(rows[-1]["timestamp"])),
        "generated_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "mid_rows_loaded_this_run": fresh_count, "m1_rows_loaded_this_run": minute_count, "raw_ticks_loaded_this_run": raw_tick_count,
        "mean_spread_jpy_this_run": (sum(all_spreads) / len(all_spreads)) if all_spreads else None,
        "max_spread_jpy_this_run": max(all_spreads) if all_spreads else None, "rolling_days": KEEP_DAYS,
    }
    meta.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(info, ensure_ascii=False))


if __name__ == "__main__":
    main()
