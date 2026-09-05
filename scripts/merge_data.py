#!/usr/bin/env python3
"""Normalize Dukascopy-node H1 CSV downloads, merge with history, keep a rolling year."""

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
        reader = csv.DictReader(f)
        for raw in reader:
            row = normalize_row(raw)
            if row:
                rows.append(row)
    return rows


def iso(ts: int) -> str:
    return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--download-dir", default="download")
    ap.add_argument("--output", default="data/usdjpy_h1.csv")
    ap.add_argument("--meta", default="data/meta.json")
    args = ap.parse_args()

    output = Path(args.output)
    meta = Path(args.meta)
    output.parent.mkdir(parents=True, exist_ok=True)

    merged: dict[int, dict[str, float | int]] = {}
    for row in load_csv(output):
        merged[int(row["timestamp"])] = row

    files = sorted(Path(p) for p in glob.glob(str(Path(args.download_dir) / "**" / "*.csv"), recursive=True))
    if not files:
        raise SystemExit(f"No downloaded CSV files found under {args.download_dir}")

    downloaded = 0
    for path in files:
        part = load_csv(path)
        downloaded += len(part)
        for row in part:
            merged[int(row["timestamp"])] = row

    if not merged:
        raise SystemExit("No valid H1 rows after merge")

    latest = max(merged)
    cutoff = latest - KEEP_DAYS * DAY_MS
    rows = [merged[k] for k in sorted(merged) if k >= cutoff and k <= latest]

    # H1 timestamps must sit exactly on an hour in UTC.
    rows = [r for r in rows if int(r["timestamp"]) % 3_600_000 == 0]
    if len(rows) < 4_000:
        raise SystemExit(f"Refusing to publish suspiciously short dataset: {len(rows)} rows")

    with output.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        for r in rows:
            writer.writerow({k: r[k] for k in FIELDS})

    info = {
        "symbol": "USDJPY",
        "timeframe": "H1",
        "price_type": "bid",
        "timezone_source": "UTC",
        "display_timezone": "Asia/Tokyo (JST, UTC+9)",
        "source": "Dukascopy bid H1",
        "bars": len(rows),
        "first_timestamp": int(rows[0]["timestamp"]),
        "last_timestamp": int(rows[-1]["timestamp"]),
        "first_utc": iso(int(rows[0]["timestamp"])),
        "last_utc": iso(int(rows[-1]["timestamp"])),
        "generated_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "downloaded_rows_this_run": downloaded,
        "rolling_days": KEEP_DAYS,
    }
    meta.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(info, ensure_ascii=False))


if __name__ == "__main__":
    main()
