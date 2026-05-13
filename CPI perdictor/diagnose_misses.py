"""Per-cut miss diagnostic.

Goal: identify the specific backtest cut(s) that all top variants are
missing — we're stuck at 95.8% hit25 (23/24) across the leaderboard,
which means 1 cut is being missed by everybody. Once we know which
target_month it is, we can design a strategy specifically for that
regime.

Runs the top 7 nowcasters from the latest race, collects per-cut
predicted vs actual YoY, and prints:
  1) A wide table: row=target_month, col=model, cell=|err in pp|
     with a "MISS" marker when |err| > 0.25
  2) A summary: which target_months are missed by N>=4 models
     (the "consensus miss" — that's our target).
"""

from __future__ import annotations

import json
import time

import numpy as np
import pandas as pd

from cpi_forecaster.api_client import get_daily_panel
from cpi_forecaster.fred import fetch_panel
from cpi_forecaster.nowcast_features import build_daily_frame


CONTESTANTS: list[tuple[str, str, str]] = [
    # (label, module, fn)
    ("ar_residual",    "cpi_forecaster.nowcast_ar_residual",      "backtest_ar_residual_nowcast"),
    ("yellen_stack",   "cpi_forecaster.nowcast_yellen_stack",     "backtest_yellen_stack_nowcast"),
    ("yellen_1_1",     "cpi_forecaster.nowcast_clev_calibrated",  "backtest_clev_calibrated_nowcast"),
    ("accel",          "cpi_forecaster.nowcast_accel",            "backtest_accel_nowcast"),
    ("grnyll",         "cpi_forecaster.nowcast_grnyll",           "backtest_grnyll_nowcast"),
    ("hingeloss",      "cpi_forecaster.nowcast_hingeloss",        "backtest_hingeloss_nowcast"),
    ("top3med",        "cpi_forecaster.nowcast_top3med",          "backtest_top3med_nowcast"),
]


def main() -> int:
    print("[diag] fetching panels...")
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    # rows: list of (label, target_month, pred_yoy, actual_yoy, abs_err)
    long_rows: list[dict] = []
    summaries: dict[str, dict] = {}

    for label, modname, fnname in CONTESTANTS:
        print(f"[diag] running {label}...")
        t0 = time.time()
        try:
            mod = __import__(modname, fromlist=[fnname])
            fn = getattr(mod, fnname)
            r = fn(panel, daily_frame, window_months=24, as_of_day=20)
        except Exception as e:
            print(f"[diag]   {label} CRASHED during import/call: {e}")
            continue
        if "error" in r:
            print(f"[diag]   {label} returned error: {r['error']}")
            continue
        if "rows" not in r:
            print(f"[diag]   {label} has no per-cut rows; skipping")
            continue
        elapsed = time.time() - t0
        summaries[label] = {
            "rmse_yoy": r.get("rmseYoy"),
            "hit25":    r.get("hitWithin25bp"),
            "secs":     elapsed,
        }
        for row in r["rows"]:
            tm = row["target_month"]
            pred = float(row["pred_yoy"])
            actual = float(row["actual_yoy"])
            abs_err = abs(pred - actual)
            long_rows.append({
                "model": label,
                "target_month": tm,
                "pred_yoy": pred,
                "actual_yoy": actual,
                "abs_err": abs_err,
                "miss": abs_err > 0.25,
            })
        print(f"[diag]   {label}: RMSE {summaries[label]['rmse_yoy']:.4f}, hit25 {summaries[label]['hit25']:.1f}% ({elapsed:.0f}s)")

    if not long_rows:
        print("[diag] no rows collected; nothing to diagnose.")
        return 1

    df = pd.DataFrame(long_rows)
    # Pivot: rows=target_month, cols=model, values=abs_err
    pivot = df.pivot_table(
        index="target_month", columns="model", values="abs_err", aggfunc="first"
    ).sort_index()

    # Build a per-cut miss-count column
    miss_pivot = (pivot > 0.25).astype(int)
    miss_pivot["MISS_CT"] = miss_pivot.sum(axis=1)

    # Pull actual_yoy per target_month (same for all models)
    actuals = df.groupby("target_month")["actual_yoy"].first().sort_index()

    # ── Print wide table ────────────────────────────────────────────────
    print()
    print("=" * 110)
    print("PER-CUT |YoY ERROR| TABLE  (cells > 0.25 marked with *)")
    print("=" * 110)
    cols = list(pivot.columns)
    header = f"{'target':<10}{'actual':>9}  " + "".join(f"{c[:11]:>12}" for c in cols) + f"  {'MISS_CT':>8}"
    print(header)
    print("-" * 110)
    for tm in pivot.index:
        actual = float(actuals.loc[tm])
        row_parts = [f"{tm:<10}{actual:>+9.2f}  "]
        for c in cols:
            v = pivot.loc[tm, c]
            if pd.isna(v):
                row_parts.append(f"{'  -  ':>12}")
            else:
                marker = "*" if v > 0.25 else " "
                row_parts.append(f"{v:>11.3f}{marker}")
        miss_ct = int(miss_pivot.loc[tm, "MISS_CT"])
        row_parts.append(f"  {miss_ct:>8}")
        print("".join(row_parts))
    print("=" * 110)

    # ── Consensus miss summary ──────────────────────────────────────────
    print()
    print("=" * 70)
    print("CONSENSUS MISSES  (cuts missed by >=4 of the top variants)")
    print("=" * 70)
    consensus = miss_pivot[miss_pivot["MISS_CT"] >= 4].copy()
    if consensus.empty:
        print("  (none — every cut is missed by <=3 of 7 models)")
    else:
        for tm, row in consensus.iterrows():
            actual = float(actuals.loc[tm])
            misses = [c for c in cols if row.get(c, 0) == 1]
            print(f"  {tm}:  actual {actual:+.2f}%   missed by {len(misses)}/{len(cols)}: {', '.join(misses)}")

    # ── The persistent miss (the cut every model gets wrong) ────────────
    print()
    print("=" * 70)
    print("UNIVERSAL MISSES  (cuts missed by ALL top variants)")
    print("=" * 70)
    universal = miss_pivot[miss_pivot["MISS_CT"] == len(cols)].copy()
    if universal.empty:
        print("  (none — at least one model gets each cut right)")
        # Still useful: which cut has the highest mean error across models?
        mean_err_per_cut = pivot.mean(axis=1).sort_values(ascending=False)
        print()
        print("  Top 5 cuts by MEAN |err| across models:")
        for tm, mean_err in mean_err_per_cut.head(5).items():
            actual = float(actuals.loc[tm])
            print(f"    {tm}:  actual {actual:+.2f}%   mean |err| {mean_err:.3f}pp")
    else:
        print("  ⚠ THE TARGET — these cuts ALL top models miss:")
        for tm, _row in universal.iterrows():
            actual = float(actuals.loc[tm])
            errs = pivot.loc[tm].dropna()
            print(f"    {tm}:  actual {actual:+.2f}%   model errs:")
            for c in cols:
                v = pivot.loc[tm, c]
                pred = df.loc[(df.model == c) & (df.target_month == tm), "pred_yoy"]
                if not pred.empty and not pd.isna(v):
                    print(f"      {c:<14} pred {float(pred.iloc[0]):+.2f}%  err {v:+.3f}pp")

    # Dump full diagnostic for downstream design work
    out = {
        "summaries": summaries,
        "rows": long_rows,
        "consensus": consensus.reset_index().to_dict("records"),
        "universal": universal.reset_index().to_dict("records"),
    }
    with open("diagnose_misses.json", "w") as f:
        json.dump(out, f, indent=2, default=str)
    print()
    print("[diag] wrote diagnose_misses.json")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
