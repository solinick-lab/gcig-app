"""Strategy horse race.

For each cut in a rolling backtest, fits every registered strategy and
records its 1-, 2-, 3-month forecasts in MoM-% and YoY-% space. Then
ranks the strategies by RMSE YoY and prints a leaderboard.
"""

from __future__ import annotations

import importlib
import json
import pkgutil
import time

import numpy as np
import pandas as pd

from . import strategies as strategies_pkg
from .features import build_target
from .fred import TARGET, fetch_panel
from .strategies import ForecastStrategy


def discover_strategies() -> list[ForecastStrategy]:
    """Auto-import every module in strategies/ and instantiate any
    ForecastStrategy subclass. Skips dunder modules and the base class."""
    found: list[ForecastStrategy] = []
    seen_names: set[str] = set()
    for _, modname, _ in pkgutil.iter_modules(strategies_pkg.__path__):
        if modname.startswith("_"):
            continue
        try:
            mod = importlib.import_module(f"cpi_forecaster.strategies.{modname}")
        except Exception as exc:
            print(f"[race] FAILED to import {modname}: {exc}")
            continue
        for attr in dir(mod):
            cls = getattr(mod, attr)
            if not isinstance(cls, type):
                continue
            if not issubclass(cls, ForecastStrategy) or cls is ForecastStrategy:
                continue
            try:
                inst = cls()
            except Exception as exc:
                print(f"[race] FAILED to instantiate {cls.__name__}: {exc}")
                continue
            if inst.name in seen_names:
                continue
            seen_names.add(inst.name)
            found.append(inst)
    return found


def race(
    panel: pd.DataFrame,
    strategies: list[ForecastStrategy],
    window: int = 36,
    horizon: int = 3,
) -> pd.DataFrame:
    """Run every strategy through the same rolling backtest. Returns
    long-form DataFrame: strategy, cut, horizon, target, mom_pred,
    mom_actual, yoy_pred, yoy_actual."""
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
    if len(y_mom) < window + 36:
        raise RuntimeError(
            f"Not enough history: need >= {window + 36} months, have {len(y_mom)}"
        )
    cut_indices = list(range(len(y_mom) - window - horizon, len(y_mom) - horizon))

    rows: list[dict] = []
    total = len(strategies) * len(cut_indices)
    completed = 0
    started = time.time()

    for s in strategies:
        for ci in cut_indices:
            cut_date = y_mom.index[ci]
            train_panel = panel.loc[panel.index <= cut_date]
            cpi_at_cut = float(cpi.asof(cut_date))
            try:
                mom_mean, _, _ = s.fit_and_predict(train_panel, horizon)
                if mom_mean is None or len(mom_mean) < horizon:
                    raise ValueError("strategy returned bad shape")
            except Exception as exc:
                print(f"[race] {s.name} crashed at {cut_date.strftime('%Y-%m')}: {exc}")
                last = float(y_mom.iloc[ci])
                mom_mean = np.array([last] * horizon)

            for h in range(1, horizon + 1):
                target_date = y_mom.index[ci + h]
                actual_mom = float(y_mom.iloc[ci + h])
                cumulative = float(np.sum(np.array(mom_mean[:h]) / 100.0))
                pred_cpi = cpi_at_cut * np.exp(cumulative)
                denom_ts = (target_date - pd.DateOffset(years=1)) + pd.offsets.MonthEnd(0)
                try:
                    denom = float(cpi.loc[denom_ts])
                except KeyError:
                    denom = float(cpi.asof(denom_ts))
                pred_yoy = (pred_cpi / denom - 1.0) * 100.0
                try:
                    actual_cpi = float(cpi.loc[target_date])
                except KeyError:
                    actual_cpi = float(cpi.asof(target_date))
                actual_yoy = (actual_cpi / denom - 1.0) * 100.0

                rows.append({
                    "strategy": s.name,
                    "cut": cut_date.strftime("%Y-%m"),
                    "horizon": int(h),
                    "target": target_date.strftime("%Y-%m"),
                    "mom_pred": float(mom_mean[h - 1]),
                    "mom_actual": float(actual_mom),
                    "yoy_pred": float(pred_yoy),
                    "yoy_actual": float(actual_yoy),
                })
            completed += 1
            elapsed = time.time() - started
            print(f"[race] {completed}/{total} ({s.name} @ {cut_date.strftime('%Y-%m')}) elapsed={elapsed:.0f}s")
    return pd.DataFrame(rows)


def report(df: pd.DataFrame) -> list[dict]:
    summary: list[dict] = []
    for s, g in df.groupby("strategy"):
        yoy_err = (g["yoy_pred"] - g["yoy_actual"]).to_numpy()
        mom_err = (g["mom_pred"] - g["mom_actual"]).to_numpy()
        rmse_yoy = float(np.sqrt(np.mean(yoy_err**2)))
        mae_yoy = float(np.mean(np.abs(yoy_err)))
        rmse_mom = float(np.sqrt(np.mean(mom_err**2)))
        within25 = float((np.abs(yoy_err) <= 0.25).mean()) * 100
        within50 = float((np.abs(yoy_err) <= 0.50).mean()) * 100
        per_h: dict[int, float] = {}
        for h, gh in g.groupby("horizon"):
            err_h = (gh["yoy_pred"] - gh["yoy_actual"]).to_numpy()
            per_h[int(h)] = float(np.sqrt(np.mean(err_h**2)))
        summary.append({
            "strategy": s,
            "rmse_yoy": rmse_yoy,
            "mae_yoy": mae_yoy,
            "rmse_mom": rmse_mom,
            "within25": within25,
            "within50": within50,
            "h1": per_h.get(1, float("nan")),
            "h2": per_h.get(2, float("nan")),
            "h3": per_h.get(3, float("nan")),
        })
    summary.sort(key=lambda r: r["rmse_yoy"])

    print()
    print("=" * 116)
    print(
        f"{'Rank':<5}{'Strategy':<28}{'RMSE YoY':>10}{'MAE YoY':>10}{'RMSE MoM':>10}"
        f"{'≤0.25pp':>10}{'≤0.50pp':>10}{'h1 RMSE':>10}{'h2 RMSE':>10}{'h3 RMSE':>10}"
    )
    print("=" * 116)
    for i, r in enumerate(summary, start=1):
        print(
            f"{i:<5}{r['strategy']:<28}{r['rmse_yoy']:>10.3f}{r['mae_yoy']:>10.3f}{r['rmse_mom']:>10.3f}"
            f"{r['within25']:>9.1f}%{r['within50']:>9.1f}%{r['h1']:>10.3f}{r['h2']:>10.3f}{r['h3']:>10.3f}"
        )
    print("=" * 116)
    if summary:
        winner = summary[0]
        baseline = next((r for r in summary if r["strategy"] == "baseline"), None)
        if baseline and winner["strategy"] != "baseline":
            improvement = (baseline["rmse_yoy"] - winner["rmse_yoy"]) / baseline["rmse_yoy"] * 100
            print(
                f"\nWinner: {winner['strategy']} — {improvement:+.1f}% RMSE YoY vs baseline."
            )
        else:
            print(f"\nWinner: {winner['strategy']}.")
    return summary


def main_race(args) -> int:
    panel = fetch_panel()
    print(f"[race] panel: {panel.shape[0]} months × {panel.shape[1]} series")
    strategies = discover_strategies()
    if args.only:
        wanted = set(args.only.split(","))
        strategies = [s for s in strategies if s.name in wanted]
    print(f"[race] strategies: {[s.name for s in strategies]}")
    if not strategies:
        print("[race] no strategies found")
        return 1
    df = race(panel, strategies, window=args.window, horizon=args.horizon)
    summary = report(df)
    if args.json:
        with open(args.json, "w") as f:
            json.dump(
                {"summary": summary, "rows": df.to_dict("records")},
                f,
                indent=2,
                default=str,
            )
        print(f"[race] wrote {args.json}")
    return 0
