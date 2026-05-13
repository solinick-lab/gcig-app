"""CLI entrypoint.

Run from the project root after `pip install -e .`:
    cpi-forecast run                   # full pipeline + post to website
    cpi-forecast run --dry-run         # compute + print, don't POST
    cpi-forecast run --json out.json   # also write the payload to disk
    cpi-forecast backtest              # detailed accuracy report
    cpi-forecast backtest --window 36  # use a longer backtest window
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback

import numpy as np

from .backtest import format_report, rolling_backtest
from .ensemble import build_champion_payload, build_ensemble, to_payload
from .fred import fetch_panel
from .models import RidgeForecaster, SarimaForecaster, XgbForecaster
from .publish import post_forecast
from .race import main_race
from .strategies.agent_s_rff import RFFStrategy
from .nowcast import run_nowcast, backtest_nowcast, DEFAULT_AS_OF_DAY
from .model_registry import production as production_model, REGISTRY, by_label
from .nowcast_ar_residual import run_ar_residual_nowcast


def _summary_line(payload: dict) -> str:
    parts = [f"as of {payload['asOfMonth']}"]
    for f in payload["forecasts"]:
        parts.append(
            f"{f['month']}: {f['yoy']:+.2f}% YoY ({f['yoyLo80']:+.2f}, {f['yoyHi80']:+.2f})"
        )
    return " | ".join(parts)


def run(args: argparse.Namespace) -> int:
    # Production model is whatever's marked production=True in
    # model_registry. Currently: Yellen 1.1 (clev_nowcast + Ridge bias-
    # correction calibrator). Backtest RMSE YoY: 0.1142.
    prod = production_model()
    print(f"[cpi-forecast] production engine: {prod.label} — {prod.description}")
    print(f"[cpi-forecast] backtest RMSE YoY: {prod.rmse:.4f}")
    print("")
    print("[cpi-forecast] fetching FRED panel...")
    panel = fetch_panel()
    print(f"[cpi-forecast] panel: {panel.shape[0]} months × {panel.shape[1]} series")

    print("[cpi-forecast] backtesting (24-month rolling window)...")
    bt = rolling_backtest(panel, window_months=24, horizon=3)
    bt_summary = bt.summary()
    rmses = {m: bt_summary["perModel"][m]["rmseMom"] for m in ("sarima", "ridge", "xgb")}
    ens_rmse = bt_summary["perModel"]["ensemble"]["rmseMom"]
    naive_rmse = bt_summary["naive"]["rmseMom"]
    print(f"[cpi-forecast] per-model MoM RMSE: {rmses}")
    print(f"[cpi-forecast] legacy ensemble MoM RMSE: {ens_rmse:.4f}  (naive: {naive_rmse:.4f})")

    # ── Production engine ─────────────────────────────────────────────
    # Yellen 1.3: Yellen 1.1 (Cleveland Fed nowcast + Ridge bias-correction)
    # plus an AR(2) correction layered on the in-sample residual series to
    # squeeze out short-memory bias. Predicts CURRENT month's CPI. We embed
    # it into the legacy 3-month forecast schema as the +1mo number (the
    # most credible horizon); +2 and +3 fall back to the RFF engine since
    # the nowcaster only does h=0.
    print(f"[cpi-forecast] running {prod.label} (current-month nowcast)...")
    nc_result = run_ar_residual_nowcast(as_of_day=20)
    print(f"[cpi-forecast]   nowcast: {nc_result.target_month} → {nc_result.pred_yoy:+.3f}% YoY  band [{nc_result.lo80_yoy:+.2f}, {nc_result.hi80_yoy:+.2f}]")

    # The +2/+3 horizons still come from the RFF engine (which works on
    # monthly data); we splice them with the nowcast for the headline +1mo.
    print(f"[cpi-forecast] running RFF for +2 and +3 month horizons...")
    champ_mean, champ_lo, champ_hi = RFFStrategy().fit_and_predict(panel, horizon=3)
    # Replace the +1 month MoM prediction with the nowcaster's
    champ_mean = np.asarray(champ_mean).copy()
    champ_lo = np.asarray(champ_lo).copy()
    champ_hi = np.asarray(champ_hi).copy()
    champ_mean[0] = nc_result.pred_mom
    # Tighten the +1mo band to the nowcaster's narrower interval
    # (nowcaster bands are in YoY space; we approximate the corresponding
    # MoM band by scaling the YoY half-width back to MoM via the chain).
    yoy_halfwidth = (nc_result.hi80_yoy - nc_result.lo80_yoy) / 2.0
    mom_halfwidth = yoy_halfwidth * 0.4  # rough scale from YoY → MoM
    champ_lo[0] = nc_result.pred_mom - mom_halfwidth
    champ_hi[0] = nc_result.pred_mom + mom_halfwidth

    # Also fit each base model standalone so the React page can still show
    # per-model contributions and the user can see what SARIMA/Ridge/XGB
    # would predict on their own. These are NOT what the headline number
    # uses — that comes from the champion.
    print("[cpi-forecast] fitting individual base models for display...")
    sarima = SarimaForecaster().fit(panel)
    ridge = RidgeForecaster().fit(panel)
    xgb_m = XgbForecaster().fit(panel)
    per_model_mom = {
        "sarima": np.asarray(sarima.predict(3)[0]),
        "ridge": np.asarray(ridge.predict(3)[0]),
        "xgb": np.asarray(xgb_m.predict(3)[0]),
    }

    payload = build_champion_payload(
        panel,
        champion_mom_mean=np.asarray(champ_mean),
        champion_mom_lo80=np.asarray(champ_lo),
        champion_mom_hi80=np.asarray(champ_hi),
        per_model_mom=per_model_mom,
        backtest=bt,
        horizon=3,
    )

    print("[cpi-forecast]", _summary_line(payload))

    if args.json:
        with open(args.json, "w") as f:
            json.dump(payload, f, indent=2)
        print(f"[cpi-forecast] wrote {args.json}")

    if args.dry_run:
        print("[cpi-forecast] --dry-run set; not posting.")
        print(json.dumps(payload, indent=2))
        return 0

    print("[cpi-forecast] posting to website...")
    resp = post_forecast(payload)
    print(f"[cpi-forecast] ingest response: {resp}")
    return 0


def backtest(args: argparse.Namespace) -> int:
    print("[cpi-forecast] fetching FRED panel...")
    panel = fetch_panel()
    print(f"[cpi-forecast] panel: {panel.shape[0]} months × {panel.shape[1]} series")
    print(f"[cpi-forecast] backtesting ({args.window}-month window, horizon={args.horizon})...")
    bt = rolling_backtest(panel, window_months=args.window, horizon=args.horizon)

    print(format_report(bt, show_table=not args.no_table))

    if args.json:
        with open(args.json, "w") as f:
            json.dump({"summary": bt.summary(), "rows": bt.to_df().to_dict(orient="records")}, f, indent=2, default=str)
        print(f"[cpi-forecast] wrote {args.json}")

    return 0


def nowcast_cmd(args: argparse.Namespace) -> int:
    """Run the nowcaster: predicts CURRENT month's CPI before BLS releases."""
    if args.race:
        return _nowcast_race(args)

    if args.backtest:
        from .fred import fetch_panel
        from .api_client import get_daily_panel
        from .nowcast_features import build_daily_frame

        print("[nowcast] backtesting...")
        panel = fetch_panel()
        daily_panel = get_daily_panel()
        daily_frame = build_daily_frame(daily_panel)
        result = backtest_nowcast(panel, daily_frame, window_months=args.window, as_of_day=args.as_of_day)
        print(f"[nowcast] as-of day {result['asOfDay']} of each target month")
        print(f"[nowcast] cuts: {result['totalCuts']}")
        print(f"[nowcast] RMSE MoM: {result['rmseMom']:.4f}")
        print(f"[nowcast] RMSE YoY: {result['rmseYoy']:.4f}")
        print(f"[nowcast] MAE YoY: {result['maeYoy']:.4f}")
        print(f"[nowcast] within ±0.25pp: {result['hitWithin25bp']:.1f}%")
        print(f"[nowcast] within ±0.50pp: {result['hitWithin50bp']:.1f}%")
        if args.json:
            with open(args.json, "w") as f:
                json.dump(result, f, indent=2, default=str)
            print(f"[nowcast] wrote {args.json}")
        return 0


def _nowcast_race(args: argparse.Namespace) -> int:
    """Race all nowcast variants against the baseline."""
    import time as _t
    from .fred import fetch_panel
    from .api_client import get_daily_panel
    from .nowcast_features import build_daily_frame

    # Lazy-import variants — each is a separate file. If a file is missing
    # or fails to import (a broken agent's strategy), skip it gracefully.
    contestants: list[tuple[str, callable]] = [("baseline", backtest_nowcast)]
    try:
        from .nowcast_quantile import backtest_quantile_nowcast
        contestants.append(("quantile", backtest_quantile_nowcast))
    except Exception as e:
        print(f"[nowcast race] skipping quantile: {e}")
    try:
        from .nowcast_richfeats import backtest_rich_nowcast
        contestants.append(("rich_features", backtest_rich_nowcast))
    except Exception as e:
        print(f"[nowcast race] skipping rich: {e}")
    try:
        from .nowcast_adaptive import backtest_adaptive_nowcast
        contestants.append(("adaptive_day", backtest_adaptive_nowcast))
    except Exception as e:
        print(f"[nowcast race] skipping adaptive: {e}")
    try:
        from .nowcast_multitarget import backtest_multitarget_nowcast
        contestants.append(("multitarget", backtest_multitarget_nowcast))
    except Exception as e:
        print(f"[nowcast race] skipping multitarget: {e}")
    try:
        from .nowcast_stacked import backtest_stacked_nowcast
        contestants.append(("stacked", backtest_stacked_nowcast))
    except Exception as e:
        print(f"[nowcast race] skipping stacked: {e}")
    # Round 2 (OOO-YYY) variants — all aiming to beat the quantile winner.
    for modname, fnname, label in [
        ("nowcast_conformal",      "backtest_conformal_nowcast",      "conformal"),
        ("nowcast_bagged",         "backtest_bagged_nowcast",         "bagged"),
        ("nowcast_quantile_rich",  "backtest_quantile_rich_nowcast",  "quantile_rich"),
        ("nowcast_histgbm",        "backtest_histgbm_nowcast",        "histgbm"),
        ("nowcast_weighted",       "backtest_weighted_nowcast",       "weighted"),
        ("nowcast_quantile_bank",  "backtest_quantile_bank_nowcast",  "quantile_bank"),
        ("nowcast_pca_quantile",   "backtest_pca_quantile_nowcast",   "pca_quantile"),
        ("nowcast_residual",       "backtest_residual_nowcast",       "residual"),
        ("nowcast_monotonic",      "backtest_monotonic_nowcast",      "monotonic"),
        ("nowcast_rff_quantile",   "backtest_rff_quantile_nowcast",   "rff_quantile"),
        ("nowcast_tips_anchor",    "backtest_tips_anchor_nowcast",    "tips_anchor"),
        # Round 3 — high-ROI improvements over quantile_rich
        ("nowcast_ensemble",       "backtest_ensemble_nowcast",       "ensemble_top3"),
        ("nowcast_altcpi",         "backtest_altcpi_nowcast",         "altcpi"),
        ("nowcast_multiday",       "backtest_multiday_nowcast",       "multiday"),
        ("nowcast_lstm",           "backtest_lstm_nowcast",           "lstm"),
        # Round 4 — subcomponent breakthrough attempts
        ("nowcast_subcomp_v2",     "backtest_subcomp_v2_nowcast",     "subcomp_v2"),
        ("nowcast_subcomp_5way",   "backtest_subcomp_5way_nowcast",   "subcomp_5way"),
        ("nowcast_subcomp_hybrid", "backtest_subcomp_hybrid_nowcast", "subcomp_hybrid"),
        # Round 5 — Cleveland Fed inflation nowcast scrape as a feature
        ("nowcast_clev",           "backtest_clev_nowcast",           "clev_nowcast"),
    ]:
        try:
            mod = __import__(f"cpi_forecaster.{modname}", fromlist=[fnname])
            contestants.append((label, getattr(mod, fnname)))
        except Exception as e:
            print(f"[nowcast race] skipping {label}: {e}")

    print(f"[nowcast race] fetching panels (will reuse for all variants)...")
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    summary: list[dict] = []
    for name, fn in contestants:
        print(f"[nowcast race] running {name}...")
        t0 = _t.time()
        try:
            r = fn(panel, daily_frame, window_months=args.window, as_of_day=args.as_of_day)
        except Exception as e:
            print(f"[nowcast race] {name} CRASHED: {e}")
            continue
        elapsed = _t.time() - t0
        if "error" in r:
            print(f"[nowcast race] {name} returned error: {r['error']}")
            continue
        row = {
            "name": name,
            "rmse_yoy": r.get("rmseYoy"),
            "rmse_mom": r.get("rmseMom"),
            "mae_yoy": r.get("maeYoy"),
            "within25": r.get("hitWithin25bp"),
            "within50": r.get("hitWithin50bp"),
            "cuts": r.get("totalCuts"),
            "secs": elapsed,
        }
        summary.append(row)
        print(f"[nowcast race] {name}: RMSE YoY {row['rmse_yoy']:.4f}, hit≤25 {row['within25']:.1f}%  ({elapsed:.0f}s)")

    summary.sort(key=lambda x: x["rmse_yoy"] if x["rmse_yoy"] is not None else 9e9)
    print()
    print("=" * 96)
    print(f"{'Rank':<5}{'Variant':<18}{'RMSE YoY':>10}{'RMSE MoM':>10}{'MAE YoY':>10}{'≤0.25pp':>10}{'≤0.50pp':>10}{'Cuts':>8}{'Sec':>8}")
    print("=" * 96)
    for i, r in enumerate(summary, start=1):
        print(f"{i:<5}{r['name']:<18}{r['rmse_yoy']:>10.4f}{r['rmse_mom']:>10.4f}{r['mae_yoy']:>10.4f}"
              f"{r['within25']:>9.1f}%{r['within50']:>9.1f}%{r['cuts']:>8}{r['secs']:>8.0f}")
    print("=" * 96)
    if summary:
        winner = summary[0]
        baseline = next((r for r in summary if r["name"] == "baseline"), None)
        if baseline and winner["name"] != "baseline":
            improvement = (baseline["rmse_yoy"] - winner["rmse_yoy"]) / baseline["rmse_yoy"] * 100
            print(f"\nWinner: {winner['name']} — {improvement:+.1f}% RMSE YoY vs baseline.")
        else:
            print(f"\nWinner: {winner['name']}.")

    if args.json:
        with open(args.json, "w") as f:
            json.dump({"summary": summary, "asOfDay": args.as_of_day, "window": args.window}, f, indent=2)
        print(f"[nowcast race] wrote {args.json}")
    return 0

    print(f"[nowcast] running nowcast (as-of-day={args.as_of_day})...")
    result = run_nowcast(as_of_day=args.as_of_day)
    print(f"[nowcast] target month: {result.target_month}")
    print(f"[nowcast] as-of: {result.as_of.strftime('%Y-%m-%d')}")
    print(f"[nowcast] days observed: {result.days_observed}")
    print(f"[nowcast] predicted MoM: {result.pred_mom:+.3f}%")
    print(f"[nowcast] predicted YoY: {result.pred_yoy:+.3f}%  (80% band {result.lo80_yoy:+.3f} → {result.hi80_yoy:+.3f})")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cpi-forecast")
    sub = parser.add_subparsers(dest="cmd")

    run_parser = sub.add_parser("run", help="Fetch, forecast, and post.")
    run_parser.add_argument("--dry-run", action="store_true", help="Compute and print, don't POST.")
    run_parser.add_argument("--json", default=None, help="Also write payload to this file.")
    run_parser.set_defaults(func=run)

    race_parser = sub.add_parser("race", help="Run strategy horse race — every strategies/*.py competes.")
    race_parser.add_argument("--window", type=int, default=24, help="Rolling backtest window (default: 24).")
    race_parser.add_argument("--horizon", type=int, default=3, help="Forecast horizon (default: 3).")
    race_parser.add_argument("--only", default=None, help="Comma-separated strategy names to include.")
    race_parser.add_argument("--json", default=None, help="Write race results JSON.")
    race_parser.set_defaults(func=main_race)

    nc_parser = sub.add_parser("nowcast", help="Predict the CURRENT month's CPI using within-month daily data.")
    nc_parser.add_argument("--as-of-day", type=int, default=DEFAULT_AS_OF_DAY,
                           help=f"Day of month to simulate as 'today' for training (default: {DEFAULT_AS_OF_DAY}).")
    nc_parser.add_argument("--backtest", action="store_true",
                           help="Run a walk-forward backtest instead of a live nowcast.")
    nc_parser.add_argument("--race", action="store_true",
                           help="Race all nowcast variants (baseline + JJJ/KKK/LLL/MMM/NNN).")
    nc_parser.add_argument("--window", type=int, default=24,
                           help="Backtest window in months (default: 24).")
    nc_parser.add_argument("--json", default=None, help="Write backtest results to this file.")
    nc_parser.set_defaults(func=nowcast_cmd)

    bt_parser = sub.add_parser("backtest", help="Detailed historical accuracy report.")
    bt_parser.add_argument("--window", type=int, default=24, help="Months in the rolling window (default: 24).")
    bt_parser.add_argument("--horizon", type=int, default=3, help="Forecast horizon in months (default: 3).")
    bt_parser.add_argument("--no-table", action="store_true", help="Skip the per-cut table.")
    bt_parser.add_argument("--json", default=None, help="Write the full per-cut report to JSON.")
    bt_parser.set_defaults(func=backtest)

    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 2
    try:
        return args.func(args)
    except Exception as exc:
        print(f"[cpi-forecast] FAILED: {exc}", file=sys.stderr)
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
