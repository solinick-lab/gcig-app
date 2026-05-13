"""Subcomponent-residual hybrid CPI nowcaster.

Builds on top of the proven `nowcast_quantile_rich` baseline by adding a
small *energy-only* correction. Energy CPI (CPIENGSL) is the most
predictable subcomponent from daily oil/gas/diesel signals, and BLS
weights it at roughly 7% of headline CPI. If a dedicated energy
specialist disagrees with what the headline model implicitly expects on
energy, we nudge the headline forecast by 7% of that disagreement.

Pipeline (per cut):
  1. Fit `nowcast_quantile_rich` on data strictly before the cut, predict
     headline MoM -> `qr_pred_mom` (the "baseline forecast").
  2. Fit a parallel energy specialist with the same rich-feature design
     matrix but targeting CPIENGSL MoM. Predict -> `energy_pred`.
  3. Fit a third quantile-rich model targeting CPIENGSL MoM with the
     headline model's *exact same* feature recipe to estimate what the
     headline model "thinks" energy is doing -> `baseline_energy_pred`.
  4. Final: `final_pred = qr_pred_mom + 0.07 * (energy_pred - baseline_energy_pred)`.
     Disagreement is clipped to a small band (+/- 0.5 MoM pp on energy)
     so a single noisy energy specialist month can't blow up headline.
  5. Chain to YoY using the same denominator as the baseline; band
     half-widths inherited from the baseline (correction is small so
     interval-width drift is negligible).

Wrapped in try/except per cut. Per-cut runtime budget: <60s. Doesn't
modify any other file.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor

from .api_client import get_daily_panel
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame
from .nowcast_quantile_rich import (
    _MOM_HI_CLIP,
    _MOM_LO_CLIP,
    _RESID_FLOOR,
    _build_inference_features_rich,
    _GBR_PARAMS,
    _QUANTILES,
    _mom_to_yoy,
    fit_quantile_rich_nowcast_model,
)
from .nowcast_richfeats import rich_features_at


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_ENERGY_ID = "CPIENGSL"          # FRED series id for headline energy CPI
_ENERGY_WEIGHT = 0.07            # BLS weight of energy in headline CPI
_CORRECTION_CLIP = 0.5           # clip energy disagreement to +/-0.5 MoM pp
_ENERGY_MOM_CLIP = 8.0           # sanity bound on energy MoM specialist out


@dataclass
class SubcompHybridResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int


# --- energy-specialist helpers --------------------------------------


def _energy_mom_log(panel: pd.DataFrame) -> pd.Series:
    """MoM log-% change of CPIENGSL (mirrors `build_target` for headline)."""
    if _ENERGY_ID not in panel.columns:
        return pd.Series([], dtype=float)
    s = panel[_ENERGY_ID].dropna()
    if len(s) < 2:
        return pd.Series([], dtype=float)
    s = s[s > 0]
    return ((np.log(s) - np.log(s.shift(1))) * 100.0).dropna().rename("y_eng_mom")


def _build_supervised_energy(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series]:
    """Same rich-feature recipe as headline, but y is CPIENGSL MoM log-%.

    Mirrors `nowcast_richfeats._build_supervised_rich` so the exact same
    feature row layout is shared between the energy specialist and the
    estimated baseline-energy expectation. Drops months where energy CPI
    is unavailable.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_head = build_target(panel).dropna()
    y_eng = _energy_mom_log(panel)
    if len(y_eng) == 0:
        return pd.DataFrame(), pd.Series([], dtype=float)

    eligible_months = y_head.index[min_history_months:]

    rows: list[dict] = []
    targets: list[float] = []
    for month_end in eligible_months:
        if month_end not in y_eng.index:
            continue
        m_start = month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)

        try:
            feats = rich_features_at(daily_frame, as_of)
        except Exception:
            continue

        # Headline-target lag features so the specialist sees the same
        # left-side history that the baseline model sees.
        try:
            feats["cpi_mom_lag1"] = float(y_head.loc[:month_end].iloc[-2])
        except Exception:
            feats["cpi_mom_lag1"] = np.nan
        try:
            feats["cpi_mom_lag2"] = (
                float(y_head.loc[:month_end].iloc[-3])
                if len(y_head.loc[:month_end]) >= 3 else np.nan
            )
        except Exception:
            feats["cpi_mom_lag2"] = np.nan
        try:
            cpi_until = cpi.loc[:month_end]
            if len(cpi_until) >= 14:
                feats["cpi_yoy_lag1"] = float(
                    (cpi_until.iloc[-2] / cpi_until.iloc[-14] - 1.0) * 100.0
                )
            else:
                feats["cpi_yoy_lag1"] = np.nan
        except Exception:
            feats["cpi_yoy_lag1"] = np.nan

        feats["month_sin"] = float(np.sin(2 * np.pi * month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * month_end.month / 12.0))
        feats["target_month_end"] = month_end
        rows.append(feats)
        targets.append(float(y_eng.loc[month_end]))

    if not rows:
        return pd.DataFrame(), pd.Series([], dtype=float)

    df = pd.DataFrame(rows).set_index("target_month_end")
    y = pd.Series(targets, index=df.index, name="y_eng_mom")
    df = df.dropna(axis=1, how="all")
    df = df.fillna(df.median(numeric_only=True))
    df = df.fillna(0.0)
    return df, y


@dataclass
class EnergySpecialistModel:
    """Q=0.5 GBR on rich features predicting CPIENGSL MoM log-%."""
    model: GradientBoostingRegressor
    feature_cols: list[str]

    def predict_one(self, x: pd.Series) -> float:
        x_aligned = x.reindex(self.feature_cols).fillna(0.0).values.reshape(1, -1)
        return float(self.model.predict(x_aligned)[0])


def fit_energy_specialist(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> EnergySpecialistModel | None:
    X, y = _build_supervised_energy(panel, daily_frame, as_of_day=as_of_day)
    if len(y) < 24:
        return None
    cols = list(X.columns)
    gbr = GradientBoostingRegressor(
        loss="quantile", alpha=0.5, **_GBR_PARAMS,
    ).fit(X.values, y.values)
    return EnergySpecialistModel(model=gbr, feature_cols=cols)


# --- public entry points --------------------------------------------


def _energy_inference_feats(
    train_panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> tuple[dict[str, float], pd.Timestamp]:
    """Use the same builder the baseline uses so feature recipes match."""
    return _build_inference_features_rich(
        train_panel, daily_frame, target_month_end, as_of_day,
    )


def backtest_subcomp_hybrid_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the subcomponent-residual hybrid nowcaster.

    For each historical cut t in the trailing `window_months`:
      - train baseline quantile_rich on data strictly before t
      - train energy specialist (CPIENGSL MoM) and a baseline-style
        energy-target model on the same pre-t data
      - predict t's headline MoM as
            qr_pred_mom + 0.07 * clip(energy_pred - baseline_energy_pred)
      - clip MoM, chain to YoY against published CPI 12m prior

    Single failed cuts are skipped via try/except. Return shape mirrors
    `nowcast.backtest_nowcast`.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    cuts = list(range(len(y_mom) - window_months, len(y_mom)))
    preds_mom: list[float] = []
    actuals_mom: list[float] = []
    preds_yoy: list[float] = []
    actuals_yoy: list[float] = []
    rows: list[dict] = []

    for ci in cuts:
        try:
            target_month_end = y_mom.index[ci]
            train_panel = panel.loc[panel.index < target_month_end]
            if len(train_panel) < 60:
                continue

            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue

            # --- Baseline forecast (quantile_rich on headline) ---
            baseline_model = fit_quantile_rich_nowcast_model(
                train_panel, daily_frame, as_of_day=as_of_day,
            )

            feats, as_of = _build_inference_features_rich(
                train_panel, daily_frame, target_month_end, as_of_day,
            )
            qr_pred_mom, qr_lo_mom, qr_hi_mom = baseline_model.predict_one(
                pd.Series(feats),
            )
            qr_pred_mom = float(np.clip(qr_pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))

            # --- Energy specialist + baseline-energy expectation ---
            energy_pred = np.nan
            baseline_energy_pred = np.nan
            try:
                energy_specialist = fit_energy_specialist(
                    train_panel, daily_frame, as_of_day=as_of_day,
                )
                if energy_specialist is not None:
                    energy_pred = float(np.clip(
                        energy_specialist.predict_one(pd.Series(feats)),
                        -_ENERGY_MOM_CLIP, _ENERGY_MOM_CLIP,
                    ))
            except Exception:
                energy_pred = np.nan

            # Baseline-implied energy expectation: same architecture as
            # `fit_quantile_rich_nowcast_model` but trained to predict
            # CPIENGSL MoM. Take the median quantile.
            try:
                Xe, ye = _build_supervised_energy(
                    train_panel, daily_frame, as_of_day=as_of_day,
                )
                if len(ye) >= 24:
                    cols_e = list(Xe.columns)
                    gbr_e = GradientBoostingRegressor(
                        loss="quantile", alpha=0.5, **_GBR_PARAMS,
                    ).fit(Xe.values, ye.values)
                    x_e = (
                        pd.Series(feats)
                        .reindex(cols_e)
                        .fillna(0.0)
                        .values.reshape(1, -1)
                    )
                    baseline_energy_pred = float(np.clip(
                        gbr_e.predict(x_e)[0],
                        -_ENERGY_MOM_CLIP, _ENERGY_MOM_CLIP,
                    ))
            except Exception:
                baseline_energy_pred = np.nan

            # --- Correction term ---
            if np.isfinite(energy_pred) and np.isfinite(baseline_energy_pred):
                disagreement = energy_pred - baseline_energy_pred
                disagreement = float(
                    np.clip(disagreement, -_CORRECTION_CLIP, _CORRECTION_CLIP)
                )
                correction = _ENERGY_WEIGHT * disagreement
            else:
                correction = 0.0

            pred_mom = float(np.clip(
                qr_pred_mom + correction, _MOM_LO_CLIP, _MOM_HI_CLIP,
            ))
            actual_mom = float(y_mom.iloc[ci])

            last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
            pred_yoy = _mom_to_yoy(pred_mom, last_cpi_train, target_month_end, cpi)

            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            preds_mom.append(pred_mom)
            actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of.strftime("%Y-%m-%d"),
                "pred_mom": round(pred_mom, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "qr_pred_mom": round(qr_pred_mom, 4),
                "energy_pred": round(energy_pred, 4) if np.isfinite(energy_pred) else None,
                "baseline_energy_pred": (
                    round(baseline_energy_pred, 4)
                    if np.isfinite(baseline_energy_pred) else None
                ),
                "correction": round(correction, 4),
            })
        except Exception:
            continue

    if not preds_mom:
        return {"error": "no successful cuts"}

    pm = np.array(preds_mom); am = np.array(actuals_mom)
    py = np.array(preds_yoy); ay = np.array(actuals_yoy)
    yoy_err = np.abs(py - ay)
    return {
        "asOfDay": as_of_day,
        "windowMonths": window_months,
        "totalCuts": len(preds_mom),
        "rmseMom": float(np.sqrt(np.mean((pm - am) ** 2))),
        "rmseYoy": float(np.sqrt(np.mean((py - ay) ** 2))),
        "maeYoy": float(np.mean(yoy_err)),
        "hitWithin25bp": float((yoy_err <= 0.25).mean()) * 100,
        "hitWithin50bp": float((yoy_err <= 0.50).mean()) * 100,
        "rows": rows,
    }


def run_subcomp_hybrid_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> SubcompHybridResult:
    """Pull live panels, fit baseline + energy specialists, produce a
    current-month headline forecast with the energy correction applied."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (
        last_released_month_end + pd.offsets.MonthBegin(1)
    ) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    # Baseline (headline) features
    feats = rich_features_at(daily_frame, as_of)
    y_mom = build_target(panel).dropna()
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

    # Baseline forecast
    baseline_model = fit_quantile_rich_nowcast_model(
        panel, daily_frame, as_of_day=as_of_day,
    )
    qr_pred_mom, qr_lo_mom, qr_hi_mom = baseline_model.predict_one(pd.Series(feats))
    qr_pred_mom = float(np.clip(qr_pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))

    # Energy specialist
    energy_pred = np.nan
    baseline_energy_pred = np.nan
    try:
        spec = fit_energy_specialist(panel, daily_frame, as_of_day=as_of_day)
        if spec is not None:
            energy_pred = float(np.clip(
                spec.predict_one(pd.Series(feats)),
                -_ENERGY_MOM_CLIP, _ENERGY_MOM_CLIP,
            ))
    except Exception:
        energy_pred = np.nan

    # Baseline-implied energy expectation
    try:
        Xe, ye = _build_supervised_energy(panel, daily_frame, as_of_day=as_of_day)
        if len(ye) >= 24:
            cols_e = list(Xe.columns)
            gbr_e = GradientBoostingRegressor(
                loss="quantile", alpha=0.5, **_GBR_PARAMS,
            ).fit(Xe.values, ye.values)
            x_e = (
                pd.Series(feats)
                .reindex(cols_e)
                .fillna(0.0)
                .values.reshape(1, -1)
            )
            baseline_energy_pred = float(np.clip(
                gbr_e.predict(x_e)[0],
                -_ENERGY_MOM_CLIP, _ENERGY_MOM_CLIP,
            ))
    except Exception:
        baseline_energy_pred = np.nan

    if np.isfinite(energy_pred) and np.isfinite(baseline_energy_pred):
        disagreement = float(np.clip(
            energy_pred - baseline_energy_pred,
            -_CORRECTION_CLIP, _CORRECTION_CLIP,
        ))
        correction = _ENERGY_WEIGHT * disagreement
    else:
        correction = 0.0

    pred_mom = float(np.clip(
        qr_pred_mom + correction, _MOM_LO_CLIP, _MOM_HI_CLIP,
    ))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(pred_mom, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(qr_lo_mom + correction, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(qr_hi_mom + correction, last_cpi, target_month_end, cpi)

    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )

    return SubcompHybridResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
    )
