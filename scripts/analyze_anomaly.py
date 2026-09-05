#!/usr/bin/env python3
"""Diagnose when USDJPY time-of-day anomalies exist, instead of optimizing PnL.

The script treats each JST entry-hour x hold-hours pair as a signed anomaly. It
reports temporal stability, walk-forward year tests, change points, and regime
conditional effects using only information available at entry.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean, median

HOUR_MS = 3_600_000
JST_MS = 9 * HOUR_MS
BP = 10_000.0
FACTOR_NAMES = ("volatility", "activity", "round_distance", "trend24")


def finite(x):
    return isinstance(x, (int, float)) and math.isfinite(x)


def avg(xs):
    vals = [x for x in xs if finite(x)]
    return sum(vals) / len(vals) if vals else None


def stdev(xs):
    vals = [x for x in xs if finite(x)]
    if len(vals) < 2:
        return None
    m = sum(vals) / len(vals)
    return math.sqrt(sum((x - m) ** 2 for x in vals) / (len(vals) - 1))


def quantile(xs, q):
    vals = sorted(x for x in xs if finite(x))
    if not vals:
        return None
    if len(vals) == 1:
        return vals[0]
    pos = (len(vals) - 1) * q
    lo = int(math.floor(pos)); hi = int(math.ceil(pos))
    if lo == hi:
        return vals[lo]
    w = pos - lo
    return vals[lo] * (1 - w) + vals[hi] * w


def iso(ts):
    return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def jst_parts(ts):
    d = datetime.fromtimestamp((ts + JST_MS) / 1000, tz=timezone.utc)
    return d.year, d.month, d.day, d.hour


def month_key(ts):
    y, m, _, _ = jst_parts(ts)
    return f"{y:04d}-{m:02d}"


def year_key(ts):
    return jst_parts(ts)[0]


def load_rows(path: Path):
    rows = []
    with path.open("r", newline="", encoding="utf-8-sig") as f:
        for raw in csv.DictReader(f):
            try:
                row = {
                    "timestamp": int(float(raw["timestamp"])),
                    "open": float(raw["open"]),
                    "high": float(raw["high"]),
                    "low": float(raw["low"]),
                    "close": float(raw["close"]),
                    "volume": float(raw.get("volume") or 0),
                }
            except (KeyError, TypeError, ValueError):
                continue
            if row["open"] > 0:
                rows.append(row)
    rows.sort(key=lambda r: r["timestamp"])
    return rows


def add_entry_state(rows):
    """Attach state features known at the H1 open; avoid using the current H1 close/range."""
    by_ts = {r["timestamp"]: r for r in rows}
    prev_open = None
    ret_window = deque(maxlen=120)
    vol_window = deque(maxlen=120)

    for row in rows:
        ts = row["timestamp"]
        if prev_open and row["open"] > 0:
            ret_window.append(math.log(row["open"] / prev_open))
        prev_open = row["open"]

        row["state_volatility"] = stdev(ret_window) if len(ret_window) >= 24 else None
        row["state_activity"] = None
        if len(vol_window) >= 24:
            med = median(vol_window)
            prev = vol_window[-1]
            row["state_activity"] = (prev / med) if med > 0 else None

        # Distance to nearest 10-pip (0.10 JPY) round level, expressed in pips.
        row["state_round_distance"] = abs(row["open"] - round(row["open"] * 10) / 10) / 0.01
        prev24 = by_ts.get(ts - 24 * HOUR_MS)
        row["state_trend24"] = (row["open"] / prev24["open"] - 1) if prev24 else None

        if row["volume"] > 0:
            vol_window.append(row["volume"])


def make_thresholds(rows):
    src = {
        "volatility": [r.get("state_volatility") for r in rows],
        "activity": [r.get("state_activity") for r in rows],
        "round_distance": [r.get("state_round_distance") for r in rows],
        "trend24": [r.get("state_trend24") for r in rows],
    }
    return {k: {"q33": quantile(v, 1 / 3), "q67": quantile(v, 2 / 3)} for k, v in src.items()}


def bucket(value, thresholds, labels=("low", "mid", "high")):
    if not finite(value) or not finite(thresholds.get("q33")) or not finite(thresholds.get("q67")):
        return "unknown"
    if value <= thresholds["q33"]:
        return labels[0]
    if value <= thresholds["q67"]:
        return labels[1]
    return labels[2]


def attach_buckets(rows, thresholds):
    for r in rows:
        r["bucket_volatility"] = bucket(r.get("state_volatility"), thresholds["volatility"])
        r["bucket_activity"] = bucket(r.get("state_activity"), thresholds["activity"])
        r["bucket_round_distance"] = bucket(r.get("state_round_distance"), thresholds["round_distance"], ("near", "mid", "far"))
        r["bucket_trend24"] = bucket(r.get("state_trend24"), thresholds["trend24"], ("down", "flat", "up"))


def grouped_effect(trades, key_fn):
    groups = defaultdict(list)
    for t in trades:
        groups[key_fn(t)].append(t["ret_bp"])
    out = []
    for k in sorted(groups, key=lambda x: str(x)):
        vals = groups[k]
        out.append({
            "key": k,
            "trades": len(vals),
            "mean_bp": avg(vals),
            "median_bp": median(vals) if vals else None,
            "win_rate": sum(v > 0 for v in vals) / len(vals) if vals else None,
        })
    return out


def detect_change_points(monthly, min_segment=6, max_points=3):
    """Simple recursive mean-shift detector; descriptive, not a formal p-value test."""
    vals = [m["mean_bp"] for m in monthly]
    points = []

    def recurse(lo, hi):
        if len(points) >= max_points or hi - lo < 2 * min_segment:
            return
        best = None
        for cut in range(lo + min_segment, hi - min_segment + 1):
            left = vals[lo:cut]; right = vals[cut:hi]
            ml = avg(left); mr = avg(right); sl = stdev(left); sr = stdev(right)
            if ml is None or mr is None:
                continue
            denom = math.sqrt(((sl or 0) ** 2 / max(len(left), 1)) + ((sr or 0) ** 2 / max(len(right), 1)))
            score = abs(ml - mr) / denom if denom > 1e-12 else 0.0
            if best is None or score > best[0]:
                best = (score, cut, ml, mr)
        if not best or best[0] < 2.0:
            return
        score, cut, ml, mr = best
        points.append({
            "month": monthly[cut]["month"] if cut < len(monthly) else monthly[-1]["month"],
            "score": score,
            "before_mean_bp": ml,
            "after_mean_bp": mr,
        })
        recurse(lo, cut); recurse(cut, hi)

    recurse(0, len(vals))
    return sorted(points, key=lambda x: x["month"])


def walk_forward_years(raw_trades):
    by_year = defaultdict(list)
    for t in raw_trades:
        by_year[t["year"]].append(t["raw_bp"])
    years = sorted(by_year)
    out = []
    prior = []
    for y in years:
        test = by_year[y]
        if len(prior) >= 2:
            train = [v for py in prior for v in by_year[py]]
            train_mean = avg(train)
            sign = 1 if (train_mean or 0) >= 0 else -1
            signed = [sign * v for v in test]
            out.append({
                "year": y,
                "train_direction": "long" if sign > 0 else "short",
                "trades": len(test),
                "mean_bp": avg(signed),
                "win_rate": sum(v > 0 for v in signed) / len(signed) if signed else None,
            })
        prior.append(y)
    return out


def strategy_analysis(rows, by_ts, entry_hour, hold, thresholds):
    raw = []
    for row in rows:
        if jst_parts(row["timestamp"])[3] != entry_hour:
            continue
        exit_row = by_ts.get(row["timestamp"] + hold * HOUR_MS)
        if not exit_row:
            continue
        r = exit_row["open"] / row["open"] - 1
        raw.append({
            "entry_ts": row["timestamp"],
            "raw_bp": r * BP,
            "month": month_key(row["timestamp"]),
            "year": year_key(row["timestamp"]),
            "buckets": {
                "volatility": row["bucket_volatility"],
                "activity": row["bucket_activity"],
                "round_distance": row["bucket_round_distance"],
                "trend24": row["bucket_trend24"],
            },
        })
    if len(raw) < 120:
        return None

    raw_mean = avg([t["raw_bp"] for t in raw]) or 0.0
    sign = 1 if raw_mean >= 0 else -1
    direction = "long" if sign > 0 else "short"
    trades = []
    for t in raw:
        x = dict(t)
        x["ret_bp"] = sign * t["raw_bp"]
        trades.append(x)

    rets = [t["ret_bp"] for t in trades]
    m = avg(rets) or 0.0; sd = stdev(rets)
    t_stat = m / (sd / math.sqrt(len(rets))) if sd and sd > 0 else None

    month_groups = defaultdict(list)
    year_groups = defaultdict(list)
    for t in trades:
        month_groups[t["month"]].append(t)
        year_groups[t["year"]].append(t)

    monthly = []
    for mk in sorted(month_groups):
        vals = [t["ret_bp"] for t in month_groups[mk]]
        monthly.append({"month": mk, "trades": len(vals), "mean_bp": avg(vals), "win_rate": sum(v > 0 for v in vals) / len(vals)})
    yearly = []
    for y in sorted(year_groups):
        vals = [t["ret_bp"] for t in year_groups[y]]
        yearly.append({"year": y, "trades": len(vals), "mean_bp": avg(vals), "win_rate": sum(v > 0 for v in vals) / len(vals)})

    regime_effects = {}
    bucket_means = {}
    for factor in FACTOR_NAMES:
        g = defaultdict(list)
        for t in trades:
            b = t["buckets"][factor]
            if b != "unknown":
                g[b].append(t["ret_bp"])
        regime_effects[factor] = [{"bucket": b, "trades": len(v), "mean_bp": avg(v), "win_rate": sum(x > 0 for x in v) / len(v)} for b, v in sorted(g.items())]
        bucket_means[factor] = {b: avg(v) for b, v in g.items()}

    # Composition decomposition: predict from marginal regime effects, then inspect residual month effect.
    overall = m
    for mo in monthly:
        ts = month_groups[mo["month"]]
        preds = []
        for t in ts:
            devs = []
            for factor in FACTOR_NAMES:
                b = t["buckets"][factor]
                bm = bucket_means.get(factor, {}).get(b)
                if finite(bm):
                    devs.append(bm - overall)
            preds.append(overall + (sum(devs) / len(devs) if devs else 0.0))
        comp = avg(preds)
        mo["composition_bp"] = comp
        mo["structural_residual_bp"] = (mo["mean_bp"] - comp) if finite(comp) else None

    wf = walk_forward_years(raw)
    month_positive = sum((x["mean_bp"] or 0) > 0 for x in monthly) / len(monthly) if monthly else None
    year_positive = sum((x["mean_bp"] or 0) > 0 for x in yearly) / len(yearly) if yearly else None
    wf_positive = sum((x["mean_bp"] or 0) > 0 for x in wf) / len(wf) if wf else None
    wf_mean = avg([x["mean_bp"] for x in wf])
    years_n = len(yearly)
    robustness = (abs(t_stat) if finite(t_stat) else 0.0) * (year_positive or 0.0) * (0.5 + 0.5 * (wf_positive if wf_positive is not None else 0.0)) * min(1.0, years_n / 5.0)

    return {
        "id": f"{entry_hour:02d}-{hold:02d}",
        "entry_hour_jst": entry_hour,
        "hold_hours": hold,
        "exit_hour_jst": (entry_hour + hold) % 24,
        "direction": direction,
        "trades": len(trades),
        "mean_bp": m,
        "median_bp": median(rets),
        "win_rate": sum(v > 0 for v in rets) / len(rets),
        "t_stat": t_stat,
        "month_positive_ratio": month_positive,
        "year_positive_ratio": year_positive,
        "walk_forward_positive_ratio": wf_positive,
        "walk_forward_mean_bp": wf_mean,
        "robustness_score": robustness,
        "first_month": monthly[0]["month"] if monthly else None,
        "last_month": monthly[-1]["month"] if monthly else None,
        "yearly": yearly,
        "monthly": monthly,
        "walk_forward_years": wf,
        "change_points": detect_change_points(monthly),
        "regime_effects": regime_effects,
    }


def compact_summary(s):
    return {k: s[k] for k in (
        "id", "entry_hour_jst", "hold_hours", "exit_hour_jst", "direction", "trades", "mean_bp", "win_rate", "t_stat",
        "month_positive_ratio", "year_positive_ratio", "walk_forward_positive_ratio", "walk_forward_mean_bp", "robustness_score", "first_month", "last_month"
    )}


def sanitize(obj):
    if isinstance(obj, dict):
        return {k: sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize(v) for v in obj]
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    return obj


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="data/usdjpy_h1.csv")
    ap.add_argument("--output", default="data/anomaly_research.json")
    ap.add_argument("--detail-limit", type=int, default=120)
    args = ap.parse_args()

    rows = load_rows(Path(args.input))
    if len(rows) < 4_000:
        raise SystemExit(f"Need at least 4,000 H1 rows, got {len(rows)}")
    add_entry_state(rows)
    thresholds = make_thresholds(rows)
    attach_buckets(rows, thresholds)
    by_ts = {r["timestamp"]: r for r in rows}

    strategies = []
    for entry in range(24):
        for hold in range(1, 25):
            s = strategy_analysis(rows, by_ts, entry, hold, thresholds)
            if s:
                strategies.append(s)
    strategies.sort(key=lambda s: (s["robustness_score"], abs(s["t_stat"] or 0)), reverse=True)

    payload = {
        "schema_version": 1,
        "generated_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "symbol": "USDJPY",
        "timeframe": "H1",
        "purpose": "temporal/regime anomaly diagnosis; not PnL parameter optimization",
        "data": {
            "bars": len(rows),
            "first_utc": iso(rows[0]["timestamp"]),
            "last_utc": iso(rows[-1]["timestamp"]),
            "years": sorted({year_key(r["timestamp"]) for r in rows}),
        },
        "state_definitions": {
            "volatility": "rolling std of up to 120 open-to-open log returns, known at entry",
            "activity": "previous completed H1 volume divided by rolling median of recent positive-volume H1 bars",
            "round_distance": "distance from entry open to nearest 0.10 JPY level, in pips",
            "trend24": "entry open / open 24h earlier - 1",
        },
        "thresholds": thresholds,
        "notes": [
            "Direction in the descriptive full-sample panel is oriented to the sign of the full-sample raw effect; do not treat it as untouched OOS evidence.",
            "walk_forward_years chooses direction from prior years only and is the cleaner forward-style diagnostic.",
            "change_points are descriptive mean-shift candidates, not formal multiple-testing-adjusted discoveries.",
            "composition_bp estimates how much monthly strength is associated with the mix of observed market states; structural_residual_bp is the remaining month effect.",
        ],
        "strategy_summaries": [compact_summary(s) for s in strategies],
        "strategy_details": strategies[: max(1, args.detail_limit)],
    }
    out = Path(args.output); out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(sanitize(payload), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"bars": len(rows), "strategies": len(strategies), "details": len(payload["strategy_details"]), "output": str(out)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
