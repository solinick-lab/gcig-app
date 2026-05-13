"""Ensemble the three models with inverse-error weights, then build the
final JSON payload the website will consume.

Inverse-error weights: weight_i = (1 / rmse_i) / sum_j (1 / rmse_j).
A model with half the RMSE of another gets twice the weight. Floor at
a tiny epsilon so a perfect-RMSE model doesn't take 100%.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from .backtest import BacktestResult
from .fred import TARGET
from .model_registry import production as production_model


@dataclass
class EnsembleForecast:
    months_ahead: list[str]               # ["YYYY-MM", ...]
    yoy_mean: list[float]                 # YoY % for each forecast month
    yoy_lo80: list[float]
    yoy_hi80: list[float]
    mom_mean: list[float]
    per_model_yoy: dict[str, list[float]] # {sarima: [...], ridge: [...], xgb: [...]}
    weights: dict[str, float]


def _inverse_error_weights(rmses: dict[str, float]) -> dict[str, float]:
    eps = 1e-6
    inverses = {k: 1.0 / max(v, eps) for k, v in rmses.items()}
    total = sum(inverses.values())
    return {k: v / total for k, v in inverses.items()}


def _yoy_from_chain(latest_cpi: float, mom_pct: np.ndarray, panel_cpi: pd.Series) -> np.ndarray:
    """Convert a chain of MoM log-% predictions to YoY % at each step.

    cpi_{T+h} = latest_cpi * exp(sum(mom[:h+1])/100)
    yoy_{T+h} = cpi_{T+h} / cpi_{T+h-12} - 1   (using historical CPI for the lag)
    """
    log_levels = np.log(latest_cpi) + np.cumsum(mom_pct / 100.0)
    levels = np.exp(log_levels)
    # For each forecast month T+h, the YoY denominator is CPI from 12 months
    # before T+h. With h up to 3, that's always within the historical panel.
    last_idx = panel_cpi.index[-1]
    yoy = []
    for h, level in enumerate(levels, start=1):
        denom_idx = last_idx + pd.DateOffset(months=h - 12)
        denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
        # Find the historical CPI at that month (or nearest available).
        try:
            denom = float(panel_cpi.loc[denom_idx])
        except KeyError:
            denom = float(panel_cpi.asof(denom_idx))
        yoy.append((level / denom - 1.0) * 100.0)
    return np.array(yoy)


def build_ensemble(
    panel: pd.DataFrame,
    per_model_predictions: dict[str, tuple[np.ndarray, np.ndarray, np.ndarray]],
    backtest: BacktestResult,
    horizon: int = 3,
) -> EnsembleForecast:
    summary = backtest.summary()
    weights = {k: float(v) for k, v in summary["weights"].items()}

    # Combine MoM means with weights.
    names = list(per_model_predictions.keys())
    mom_stack = np.stack([per_model_predictions[n][0] for n in names], axis=0)
    w = np.array([weights[n] for n in names]).reshape(-1, 1)
    mom_mean = (mom_stack * w).sum(axis=0)

    # For intervals: combine using sqrt of weighted variance + a between-model
    # disagreement term. The disagreement-to-uncertainty mapping is rough
    # but sane: when models disagree a lot, the band widens.
    los = np.stack([per_model_predictions[n][1] for n in names], axis=0)
    his = np.stack([per_model_predictions[n][2] for n in names], axis=0)
    spread_within = ((his - los) / 2.0)
    spread_blend = (spread_within * w).sum(axis=0)
    disagreement = mom_stack.std(axis=0)
    spread_total = np.sqrt(spread_blend**2 + disagreement**2)

    cpi = panel[TARGET.fred_id].dropna()
    latest = float(cpi.iloc[-1])
    yoy_mean = _yoy_from_chain(latest, mom_mean, cpi)
    yoy_lo = _yoy_from_chain(latest, mom_mean - spread_total, cpi)
    yoy_hi = _yoy_from_chain(latest, mom_mean + spread_total, cpi)

    per_model_yoy = {
        n: _yoy_from_chain(latest, per_model_predictions[n][0], cpi).tolist()
        for n in names
    }

    last_month = cpi.index[-1]
    months_ahead = [
        (last_month + pd.DateOffset(months=h)).strftime("%Y-%m")
        for h in range(1, horizon + 1)
    ]

    return EnsembleForecast(
        months_ahead=months_ahead,
        yoy_mean=yoy_mean.tolist(),
        yoy_lo80=yoy_lo.tolist(),
        yoy_hi80=yoy_hi.tolist(),
        mom_mean=mom_mean.tolist(),
        per_model_yoy=per_model_yoy,
        weights=weights,
    )


def build_champion_payload(
    panel: pd.DataFrame,
    champion_mom_mean: np.ndarray,
    champion_mom_lo80: np.ndarray,
    champion_mom_hi80: np.ndarray,
    per_model_mom: dict[str, np.ndarray],
    backtest: BacktestResult,
    horizon: int = 3,
) -> dict:
    """Build the website payload from the champion strategy's MoM predictions.

    The headline numbers (yoy, yoyLo80, yoyHi80, mom) come from the
    champion. The modelContributions and weights fields are populated
    from the individual SARIMA/Ridge/XGBoost predictions so users still
    see what each base model would say standalone — same React schema
    as the legacy ensemble, no client changes needed.
    """
    cpi = panel[TARGET.fred_id].dropna()
    last_yoy = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    last_month = cpi.index[-1]

    months_ahead = [
        (last_month + pd.DateOffset(months=h)).strftime("%Y-%m")
        for h in range(1, horizon + 1)
    ]

    yoy_mean = _yoy_from_chain(float(cpi.iloc[-1]), champion_mom_mean, cpi)
    yoy_lo80 = _yoy_from_chain(float(cpi.iloc[-1]), champion_mom_lo80, cpi)
    yoy_hi80 = _yoy_from_chain(float(cpi.iloc[-1]), champion_mom_hi80, cpi)

    per_model_yoy = {
        name: _yoy_from_chain(float(cpi.iloc[-1]), preds, cpi)
        for name, preds in per_model_mom.items()
    }

    forecasts = []
    for i, m in enumerate(months_ahead):
        forecasts.append({
            "month": m,
            "yoy": round(float(yoy_mean[i]), 3),
            "yoyLo80": round(float(yoy_lo80[i]), 3),
            "yoyHi80": round(float(yoy_hi80[i]), 3),
            "mom": round(float(champion_mom_mean[i]), 3),
            "modelContributions": {
                name: round(float(per_model_yoy[name][i]), 3)
                for name in ("sarima", "ridge", "xgb")
                if name in per_model_yoy
            },
        })

    bt_summary = backtest.summary()
    per_model_rmse_mom = {
        m: bt_summary["perModel"][m]["rmseMom"]
        for m in ("sarima", "ridge", "xgb")
        if m in bt_summary["perModel"]
    }
    ensemble_rmse_mom = bt_summary["perModel"].get("ensemble", {}).get("rmseMom")
    naive_rmse_mom = bt_summary["naive"]["rmseMom"]

    # Display "weights" the React page already renders. With stacking,
    # the actual mixing is done per-horizon by the meta-learner — there
    # are no single per-model scalars to expose. Show the inverse-error
    # weights from the legacy ensemble for backwards compat (they're
    # informational, not used for the headline forecast).
    weights = bt_summary.get("weights", {"sarima": 0.33, "ridge": 0.34, "xgb": 0.33})

    # Engine identity drives the React display. Pull it from the registry
    # so promoting a new champion (Yellen 1.4, Powell 2.0, etc.) updates
    # the page automatically — no React redeploy needed.
    prod = production_model()
    return {
        "runAt": datetime.now(timezone.utc).isoformat(),
        "asOfMonth": cpi.index[-1].strftime("%Y-%m"),
        "horizonMonths": horizon,
        "lastReleasedYoy": round(last_yoy, 3),
        "engine": prod.slug,
        "engineLabel": prod.label,
        "engineDescription": prod.description,
        "engineRmseYoy": prod.rmse,
        "weights": {k: round(float(v), 4) for k, v in weights.items()},
        "forecasts": forecasts,
        "backtest": {
            "windowMonths": backtest.window_months,
            "ensembleRmseMom": ensemble_rmse_mom,
            "naiveRmseMom": naive_rmse_mom,
            "perModelRmseMom": per_model_rmse_mom,
            "perModel": bt_summary["perModel"],
            "perHorizon": bt_summary["perHorizon"],
        },
    }


def to_payload(
    panel: pd.DataFrame,
    ensemble: EnsembleForecast,
    backtest: BacktestResult,
) -> dict:
    cpi = panel[TARGET.fred_id].dropna()
    last_yoy = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)

    forecasts = []
    for i, m in enumerate(ensemble.months_ahead):
        forecasts.append({
            "month": m,
            "yoy": round(ensemble.yoy_mean[i], 3),
            "yoyLo80": round(ensemble.yoy_lo80[i], 3),
            "yoyHi80": round(ensemble.yoy_hi80[i], 3),
            "mom": round(ensemble.mom_mean[i], 3),
            "modelContributions": {
                "sarima": round(ensemble.per_model_yoy["sarima"][i], 3),
                "ridge": round(ensemble.per_model_yoy["ridge"][i], 3),
                "xgb": round(ensemble.per_model_yoy["xgb"][i], 3),
            },
        })

    bt_summary = backtest.summary()
    per_model_rmse_mom = {
        m: bt_summary["perModel"][m]["rmseMom"]
        for m in ("sarima", "ridge", "xgb")
        if m in bt_summary["perModel"]
    }
    ensemble_rmse_mom = bt_summary["perModel"].get("ensemble", {}).get("rmseMom")
    naive_rmse_mom = bt_summary["naive"]["rmseMom"]

    return {
        "runAt": datetime.now(timezone.utc).isoformat(),
        "asOfMonth": cpi.index[-1].strftime("%Y-%m"),
        "horizonMonths": len(ensemble.months_ahead),
        "lastReleasedYoy": round(last_yoy, 3),
        "weights": {k: round(v, 4) for k, v in ensemble.weights.items()},
        "forecasts": forecasts,
        "backtest": {
            "windowMonths": backtest.window_months,
            "ensembleRmseMom": ensemble_rmse_mom,
            "naiveRmseMom": naive_rmse_mom,
            "perModelRmseMom": per_model_rmse_mom,
            # Richer accuracy fields the React /cpi page can surface later.
            "perModel": bt_summary["perModel"],
            "perHorizon": bt_summary["perHorizon"],
        },
    }
