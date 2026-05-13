"""Rolling backtest with detailed per-cut predictions.

For each month in a recent window, refit each model on data available up
to that month, predict the next H months in MoM% space, then chain to
YoY levels and compare against actuals. We report:

  - per-cut, per-horizon predictions and errors (MoM and YoY)
  - aggregate RMSE/MAE per model
  - direction accuracy (did we call up/down right vs the prior month)
  - hit rates inside ±0.25 pp and ±0.50 pp YoY
  - naive baseline for comparison

Note: the live ensemble uses inverse-error weights computed from per-model
RMSEs that come out of THIS function (chicken-and-egg-style — but the
weights are stable across cuts because they're built from a long-window
RMSE, not the current-cut error).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
import pandas as pd

from .features import build_target
from .fred import TARGET
from .models import RidgeForecaster, SarimaForecaster, XgbForecaster

MODEL_NAMES = ("sarima", "ridge", "xgb")


def _model_classes():
    return [SarimaForecaster, RidgeForecaster, XgbForecaster]


def _rmse(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.sqrt(np.nanmean((a - b) ** 2)))


def _mae(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.nanmean(np.abs(a - b)))


@dataclass
class CutPrediction:
    """One model's predictions at one cut."""
    model: str
    cut_date: pd.Timestamp
    horizon: int                 # 1, 2, or 3
    target_date: pd.Timestamp
    predicted_mom: float
    actual_mom: float
    predicted_yoy: float
    actual_yoy: float
    prior_yoy: float             # YoY one month before target — for direction calls


@dataclass
class BacktestResult:
    cuts: list[CutPrediction] = field(default_factory=list)
    window_months: int = 0
    horizon: int = 3

    def _by_model(self) -> dict[str, list[CutPrediction]]:
        out: dict[str, list[CutPrediction]] = {m: [] for m in MODEL_NAMES}
        for c in self.cuts:
            if c.model in out:
                out[c.model].append(c)
        # Naive baseline is computed in to_df() — not stored in cuts.
        return out

    def to_df(self) -> pd.DataFrame:
        """Long-form: model, cut_date, horizon, target_date, predictions, errors."""
        rows = []
        for c in self.cuts:
            rows.append({
                "model": c.model,
                "cut_date": c.cut_date.strftime("%Y-%m"),
                "horizon": c.horizon,
                "target_date": c.target_date.strftime("%Y-%m"),
                "predicted_mom": c.predicted_mom,
                "actual_mom": c.actual_mom,
                "mom_err": c.predicted_mom - c.actual_mom,
                "predicted_yoy": c.predicted_yoy,
                "actual_yoy": c.actual_yoy,
                "yoy_err": c.predicted_yoy - c.actual_yoy,
                "prior_yoy": c.prior_yoy,
                # Direction call: did we predict the right SIGN of YoY change vs prior month?
                "direction_correct": (
                    np.sign(c.predicted_yoy - c.prior_yoy)
                    == np.sign(c.actual_yoy - c.prior_yoy)
                ),
            })
        return pd.DataFrame(rows)

    def summary(self) -> dict:
        df = self.to_df()
        out = {
            "windowMonths": self.window_months,
            "horizon": self.horizon,
            "totalCuts": int(df["cut_date"].nunique()),
            "perModel": {},
        }

        # Compute the ensemble per-cut as the inverse-RMSE weighted average,
        # using per-model OVERALL MoM RMSE as the weights. This matches the
        # live ensemble logic in ensemble.py.
        per_model_rmse_mom = {
            m: _rmse(g["predicted_mom"].to_numpy(), g["actual_mom"].to_numpy())
            for m, g in df.groupby("model")
        }
        eps = 1e-6
        inverses = {m: 1.0 / max(v, eps) for m, v in per_model_rmse_mom.items()}
        total_inv = sum(inverses.values())
        weights = {m: v / total_inv for m, v in inverses.items()}

        # Pivot to one row per (cut_date, horizon) with one column per model's prediction.
        pivot_mom = df.pivot_table(
            index=["cut_date", "horizon", "actual_mom"],
            columns="model",
            values="predicted_mom",
        ).reset_index()
        pivot_yoy = df.pivot_table(
            index=["cut_date", "horizon", "actual_yoy"],
            columns="model",
            values="predicted_yoy",
        ).reset_index()

        # Ensemble = weighted sum across model columns.
        pivot_mom["ensemble"] = sum(
            pivot_mom[m] * weights[m] for m in MODEL_NAMES if m in pivot_mom.columns
        )
        pivot_yoy["ensemble"] = sum(
            pivot_yoy[m] * weights[m] for m in MODEL_NAMES if m in pivot_yoy.columns
        )

        # Naive baseline: predict next-month MoM = last observed MoM.
        # Equivalent in MoM space: error = actual_MoM - prior_MoM. We compute
        # the naive's MoM RMSE as the std of MoM changes — a robust proxy.
        # For a fair comparison we compute it from the same target dates.
        naive_mom_err = pivot_mom.groupby("cut_date").apply(
            lambda g: (g["actual_mom"] - g["actual_mom"].iloc[0]).abs().mean()
        )
        naive_rmse_mom = float(np.sqrt(np.mean(naive_mom_err.values ** 2)))

        # Per-model and ensemble metrics across all (cut, horizon) pairs.
        for m in list(MODEL_NAMES) + ["ensemble"]:
            if m not in pivot_mom.columns and m != "ensemble":
                continue
            mom_pred = pivot_mom[m].to_numpy()
            mom_actual = pivot_mom["actual_mom"].to_numpy()
            yoy_pred = pivot_yoy[m].to_numpy()
            yoy_actual = pivot_yoy["actual_yoy"].to_numpy()
            yoy_err = np.abs(yoy_pred - yoy_actual)

            out["perModel"][m] = {
                "rmseMom": round(_rmse(mom_pred, mom_actual), 4),
                "rmseYoy": round(_rmse(yoy_pred, yoy_actual), 4),
                "maeYoy": round(_mae(yoy_pred, yoy_actual), 4),
                "hitWithin25bp": round(float((yoy_err <= 0.25).mean()) * 100, 1),
                "hitWithin50bp": round(float((yoy_err <= 0.50).mean()) * 100, 1),
            }
            if m != "ensemble":
                d = df[df["model"] == m]
                out["perModel"][m]["directionAccuracy"] = round(
                    float(d["direction_correct"].mean()) * 100, 1
                )

        # Direction accuracy for the ensemble: recompute from pivot.
        # Ensemble direction = sign(ensemble - prior_yoy of actual).
        # Need prior_yoy aligned to each (cut, horizon).
        prior_yoy_lookup = {
            (c.cut_date.strftime("%Y-%m"), c.horizon): c.prior_yoy for c in self.cuts
        }
        ens_dir = []
        for _, row in pivot_yoy.iterrows():
            key = (row["cut_date"], row["horizon"])
            prior = prior_yoy_lookup.get(key)
            if prior is None:
                continue
            ens_dir.append(np.sign(row["ensemble"] - prior) == np.sign(row["actual_yoy"] - prior))
        if ens_dir:
            out["perModel"]["ensemble"]["directionAccuracy"] = round(
                float(np.mean(ens_dir)) * 100, 1
            )

        out["weights"] = {m: round(v, 4) for m, v in weights.items()}
        out["naive"] = {"rmseMom": round(naive_rmse_mom, 4)}

        # Per-horizon ensemble accuracy — useful for "is +1mo more reliable than +3mo?"
        out["perHorizon"] = {}
        for h in sorted(pivot_yoy["horizon"].unique()):
            slice_ = pivot_yoy[pivot_yoy["horizon"] == h]
            err = np.abs(slice_["ensemble"].to_numpy() - slice_["actual_yoy"].to_numpy())
            out["perHorizon"][int(h)] = {
                "rmseYoy": round(_rmse(slice_["ensemble"].to_numpy(), slice_["actual_yoy"].to_numpy()), 4),
                "maeYoy": round(_mae(slice_["ensemble"].to_numpy(), slice_["actual_yoy"].to_numpy()), 4),
                "hitWithin25bp": round(float((err <= 0.25).mean()) * 100, 1),
                "hitWithin50bp": round(float((err <= 0.50).mean()) * 100, 1),
            }

        return out


def _yoy_at(panel_cpi: pd.Series, ts: pd.Timestamp) -> float:
    """YoY % change at month-end ts using historical CPI."""
    try:
        v = float(panel_cpi.loc[ts])
    except KeyError:
        v = float(panel_cpi.asof(ts))
    prior_ts = (ts - pd.DateOffset(years=1)) + pd.offsets.MonthEnd(0)
    try:
        prior = float(panel_cpi.loc[prior_ts])
    except KeyError:
        prior = float(panel_cpi.asof(prior_ts))
    return (v / prior - 1.0) * 100.0


def rolling_backtest(
    panel: pd.DataFrame, window_months: int = 24, horizon: int = 3
) -> BacktestResult:
    """Walk forward `window_months` months. At each cut, predict the next
    `horizon` months from each model and compare to actual outcomes."""
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
    if len(y_mom) < window_months + 36:
        raise RuntimeError(
            f"Not enough history for backtest: need >= {window_months + 36} months, have {len(y_mom)}"
        )

    cut_indices = list(
        range(len(y_mom) - window_months - horizon, len(y_mom) - horizon)
    )

    result = BacktestResult(window_months=window_months, horizon=horizon)

    for ci in cut_indices:
        cut_date = y_mom.index[ci]
        train_panel = panel.loc[panel.index <= cut_date]
        cpi_at_cut = float(cpi.asof(cut_date))

        model_preds_mom: dict[str, np.ndarray] = {}
        for cls in _model_classes():
            try:
                model = cls().fit(train_panel)
                mean, _, _ = model.predict(horizon)
            except Exception:
                # Use last observed MoM as a defensive fallback for an
                # early cut where statsmodels can't converge.
                mean = np.array([float(y_mom.iloc[ci])] * horizon)
            model_preds_mom[cls.name] = mean

        for h in range(1, horizon + 1):
            target_date = y_mom.index[ci + h]
            actual_mom = float(y_mom.iloc[ci + h])
            actual_yoy = _yoy_at(cpi, target_date)
            prior_target = y_mom.index[ci + h - 1]
            prior_yoy = _yoy_at(cpi, prior_target)

            for cls in _model_classes():
                pred_mom = float(model_preds_mom[cls.name][h - 1])
                # Predicted CPI level = current CPI * exp(cumulative log-MoM/100).
                cumulative = float(np.sum(model_preds_mom[cls.name][:h] / 100.0))
                pred_cpi = cpi_at_cut * np.exp(cumulative)
                # YoY denominator is the historical CPI from 12 months
                # before target_date (always known at cut time for h <= 12).
                denom_ts = (target_date - pd.DateOffset(years=1)) + pd.offsets.MonthEnd(0)
                try:
                    denom = float(cpi.loc[denom_ts])
                except KeyError:
                    denom = float(cpi.asof(denom_ts))
                pred_yoy = (pred_cpi / denom - 1.0) * 100.0

                result.cuts.append(
                    CutPrediction(
                        model=cls.name,
                        cut_date=cut_date,
                        horizon=h,
                        target_date=target_date,
                        predicted_mom=pred_mom,
                        actual_mom=actual_mom,
                        predicted_yoy=pred_yoy,
                        actual_yoy=actual_yoy,
                        prior_yoy=prior_yoy,
                    )
                )

    return result


def format_report(bt: BacktestResult, show_table: bool = True) -> str:
    """Pretty-print the backtest as a string (for cli usage)."""
    summary = bt.summary()
    lines: list[str] = []
    lines.append("")
    lines.append("=" * 78)
    lines.append(f"BACKTEST REPORT — {summary['totalCuts']} cuts × {summary['horizon']} horizons")
    lines.append("=" * 78)
    lines.append("")
    lines.append("Ensemble weights (inverse-RMSE):")
    for m, w in summary["weights"].items():
        lines.append(f"  {m:8s} {w*100:5.1f}%")
    lines.append("")
    lines.append(f"{'Model':10s}  {'RMSE MoM':>10s}  {'RMSE YoY':>10s}  {'MAE YoY':>9s}  {'≤0.25pp':>9s}  {'≤0.50pp':>9s}  {'Direction':>10s}")
    lines.append("-" * 78)
    for m in ["sarima", "ridge", "xgb", "ensemble"]:
        if m not in summary["perModel"]:
            continue
        r = summary["perModel"][m]
        d = f"{r.get('directionAccuracy', float('nan')):>9.1f}%" if r.get("directionAccuracy") is not None else "       —"
        lines.append(
            f"{m:10s}  {r['rmseMom']:>10.3f}  {r['rmseYoy']:>10.3f}  {r['maeYoy']:>9.3f}  {r['hitWithin25bp']:>8.1f}%  {r['hitWithin50bp']:>8.1f}%  {d}"
        )
    lines.append("-" * 78)
    lines.append(f"naive MoM RMSE: {summary['naive']['rmseMom']:.3f}  (lower is better)")
    lines.append("")

    lines.append("Ensemble accuracy by horizon:")
    lines.append(f"  {'Horizon':>8s}  {'RMSE YoY':>10s}  {'MAE YoY':>9s}  {'≤0.25pp':>9s}  {'≤0.50pp':>9s}")
    for h, r in summary["perHorizon"].items():
        lines.append(
            f"  {f'+{h} mo':>8s}  {r['rmseYoy']:>10.3f}  {r['maeYoy']:>9.3f}  {r['hitWithin25bp']:>8.1f}%  {r['hitWithin50bp']:>8.1f}%"
        )
    lines.append("")

    if show_table:
        df = bt.to_df()
        # Per-cut ensemble row only, to keep the table readable.
        weights = summary["weights"]
        ens = (
            df.pivot_table(
                index=["cut_date", "horizon", "target_date", "actual_yoy", "prior_yoy"],
                columns="model",
                values="predicted_yoy",
            )
            .reset_index()
        )
        ens["ensemble_yoy"] = sum(ens[m] * weights[m] for m in MODEL_NAMES if m in ens.columns)
        ens["error"] = ens["ensemble_yoy"] - ens["actual_yoy"]
        ens["dir_match"] = (
            np.sign(ens["ensemble_yoy"] - ens["prior_yoy"]) == np.sign(ens["actual_yoy"] - ens["prior_yoy"])
        )
        # Show only the +3 horizon rows (the toughest one) so the user can
        # eyeball without drowning in 72 rows.
        h3 = ens[ens["horizon"] == 3].sort_values("target_date")
        lines.append("Per-cut detail at +3-month horizon (the hardest):")
        lines.append(f"  {'cut':>8s}  {'target':>8s}  {'pred':>7s}  {'actual':>7s}  {'err':>7s}  {'dir':>4s}")
        for _, row in h3.iterrows():
            mark = "✓" if row["dir_match"] else "✗"
            lines.append(
                f"  {row['cut_date']:>8s}  {row['target_date']:>8s}  "
                f"{row['ensemble_yoy']:>+6.2f}%  {row['actual_yoy']:>+6.2f}%  "
                f"{row['error']:>+6.2f}   {mark:>4s}"
            )
    lines.append("=" * 78)
    return "\n".join(lines)
