"""Spline-feature nowcaster.

Hypothesis: Yellen 1.1's clev_nowcast pipeline uses linear quantile
regression on top of raw continuous features. CPI dynamics are
nonlinear — oil price pass-through saturates, breakeven response is
asymmetric, and lagged CPI mean-reversion is convex near the tails.
A SplineTransformer (B-spline basis, degree=3, n_knots=5 quantile-spaced)
applied to the most informative continuous features lets a regularized
linear model (ElasticNetCV) capture those local curvatures while
keeping bias well controlled.

Pipeline (per backtest cut):
  1. Build the SAME supervised matrix used by clev_nowcast (X, y) on the
     training window — same feature set, same as_of_day.
  2. Identify the "top continuous features" to expand:
        cpi_mom_lag1, cpi_mom_lag2, cpi_yoy_lag1,
        oil_level/oil_level_d20/oil_yoy_pct,
        breakeven_5y_level, breakeven_10y_level,
        gas_level/gas_yoy_pct, mich_level/mich_d20.
     Each present feature is passed through SplineTransformer
     (degree=3, n_knots=5, knots="quantile", extrapolation="constant").
  3. Concatenate spline expansions with the rest of X (raw),
     StandardScaler, then ElasticNetCV (l1_ratio over a small grid)
     fit on the point target y.
  4. Point prediction comes from the elastic net. 80% bands are
     quantile-regression-style: residual std on the in-sample fit
     scaled by z=1.2816 (one-sided 90th percentile of N(0,1) → 80% CI).

Public API:
  backtest_spline_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_spline_nowcast(as_of_day=20) -> SplineNowcastResult

Robustness: every cut wrapped in try/except; MoM clipped to clev's
[_MOM_LO_CLIP, _MOM_HI_CLIP] range; band half-widths floored.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.linear_model import ElasticNetCV
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import SplineTransformer, StandardScaler

from .api_client import get_daily_panel
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame
from .nowcast_richfeats import rich_features_at
from .nowcast_clev import (
    _safe_get_clev,
    _clev_features_for_month,
    _build_supervised_clev,
    _mom_to_yoy,
    _MOM_LO_CLIP,
    _MOM_HI_CLIP,
    _RESID_FLOOR,
)


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_SPLINE_DEGREE = 3
_SPLINE_N_KNOTS = 5
_Z_80 = 1.2816  # one-sided 90th pct of N(0,1) → symmetric 80% band

# Candidate "top continuous features" — those typically present in
# clev_nowcast's supervised matrix that have meaningful nonlinear
# response curves (CPI lags, oil, breakevens, MICH, gas).
_SPLINE_CANDIDATES = (
    "cpi_mom_lag1",
    "cpi_mom_lag2",
    "cpi_yoy_lag1",
    "oil_level",
    "oil_level_d20",
    "oil_yoy_pct",
    "breakeven_5y_level",
    "breakeven_5y_d20",
    "breakeven_10y_level",
    "breakeven_10y_d20",
    "mich_level",
    "mich_d20",
    "gas_level",
    "gas_yoy_pct",
)

_L1_RATIO_GRID = (0.1, 0.3, 0.5, 0.7, 0.9)
_ENET_CV_FOLDS = 5
_ENET_MAX_ITER = 5_000

_RESID_STD_FLOOR = 0.05  # floor on in-sample residual std (MoM)


@dataclass
class SplineNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    n_spline_feats: int
    n_train_rows: int


# ---------------------------------------------------------------------------
# Pipeline construction
# ---------------------------------------------------------------------------


def _spline_columns_present(X: pd.DataFrame) -> list[str]:
    """Subset of _SPLINE_CANDIDATES that exist (and have variance) in X."""
    out: list[str] = []
    for c in _SPLINE_CANDIDATES:
        if c in X.columns:
            try:
                col = X[c]
                if col.notna().sum() < 2:
                    continue
                if float(np.nanstd(col.values)) < 1e-9:
                    continue
                out.append(c)
            except Exception:
                continue
    return out


def _build_pipeline(spline_cols: list[str], all_cols: list[str]) -> Pipeline:
    """ColumnTransformer: spline-expand selected cols, passthrough the rest.

    Then StandardScaler → ElasticNetCV.
    """
    other_cols = [c for c in all_cols if c not in spline_cols]

    transformers: list[tuple] = []
    if spline_cols:
        spline = SplineTransformer(
            degree=_SPLINE_DEGREE,
            n_knots=_SPLINE_N_KNOTS,
            knots="quantile",
            extrapolation="constant",
            include_bias=False,
        )
        transformers.append(("spline", spline, spline_cols))
    if other_cols:
        transformers.append(("pass", "passthrough", other_cols))

    if not transformers:
        # Degenerate fallback — should not happen given X always has cols
        transformers = [("pass", "passthrough", all_cols)]

    pre = ColumnTransformer(transformers=transformers, remainder="drop")

    enet = ElasticNetCV(
        l1_ratio=list(_L1_RATIO_GRID),
        cv=_ENET_CV_FOLDS,
        max_iter=_ENET_MAX_ITER,
        n_alphas=50,
        fit_intercept=True,
    )

    return Pipeline(steps=[
        ("pre", pre),
        ("scaler", StandardScaler(with_mean=True, with_std=True)),
        ("enet", enet),
    ])


def _fit_spline_model(X: pd.DataFrame, y: pd.Series) -> tuple[Pipeline, float, list[str]]:
    """Fit pipeline. Return (model, residual_std, spline_cols_used)."""
    spline_cols = _spline_columns_present(X)
    all_cols = list(X.columns)
    pipe = _build_pipeline(spline_cols, all_cols)

    Xv = X.copy()
    # Pipeline expects numeric DataFrame with no NaNs going into the
    # ColumnTransformer. clev's _build_supervised_clev already drops
    # NaN rows, but we defensively impute residual NaNs with column
    # medians here.
    medians = Xv.median(numeric_only=True)
    Xv = Xv.fillna(medians).fillna(0.0)

    pipe.fit(Xv, y.values)
    in_sample = pipe.predict(Xv)
    resid = y.values - in_sample
    # Use ddof=1; clamp at a small floor so bands are never collapsed.
    resid_std = float(np.std(resid, ddof=1)) if len(resid) > 1 else _RESID_STD_FLOOR
    if not np.isfinite(resid_std) or resid_std < _RESID_STD_FLOOR:
        resid_std = _RESID_STD_FLOOR
    return pipe, resid_std, spline_cols


def _predict_with_bands(
    pipe: Pipeline, x_inf: pd.Series, cols: list[str], resid_std: float
) -> tuple[float, float, float]:
    """Return (mid, lo80, hi80) in MoM space."""
    row = x_inf.reindex(cols).to_frame().T
    row = row.fillna(0.0)
    try:
        mid = float(pipe.predict(row)[0])
    except Exception:
        mid = 0.0
    half = _Z_80 * resid_std
    return mid, mid - half, mid + half


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_spline_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the spline-feature nowcaster."""
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok") and clev.get("historical"))

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

            X, y = _build_supervised_clev(
                train_panel, daily_frame, clev, as_of_day=as_of_day,
            )
            if len(X) < 24:
                continue

            pipe, resid_std, spline_cols = _fit_spline_model(X, y)
            cols = list(X.columns)

            # --- inference features (same recipe as clev_nowcast) ---
            m_start = target_month_end + pd.offsets.MonthBegin(-1)
            as_of = _as_of_for_month(m_start, as_of_day)
            feats = rich_features_at(daily_frame, as_of)
            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue
            feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
            feats["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
            feats["cpi_yoy_lag1"] = float(
                (train_panel[TARGET.fred_id].dropna().iloc[-1]
                 / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0) * 100.0
            )
            feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
            feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
            try:
                feats.update(_clev_features_for_month(clev, target_month_end, panel))
            except Exception:
                pass

            x_inf = pd.Series(feats)
            x_inf = x_inf.reindex(cols).fillna(X.median(numeric_only=True)).fillna(0.0)

            mid, lo_mom, hi_mom = _predict_with_bands(pipe, x_inf, cols, resid_std)
            mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))

            actual_mom = float(y_mom.iloc[ci])
            last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
            pred_yoy = _mom_to_yoy(mid, last_cpi_train, target_month_end, cpi)
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0

            preds_mom.append(mid)
            actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of.strftime("%Y-%m-%d"),
                "pred_mom": round(mid, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "n_spline_feats": len(spline_cols),
                "resid_std": round(resid_std, 4),
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
        "usedClevScrape": used_scrape,
        "rows": rows,
    }


def run_spline_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> SplineNowcastResult:
    """Live nowcast: fit spline-elastic-net pipeline on full history, predict next month."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    pipe, resid_std, spline_cols = _fit_spline_model(X, y)
    cols = list(X.columns)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    y_mom = build_target(panel).dropna()
    feats = rich_features_at(daily_frame, as_of)
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    try:
        feats.update(_clev_features_for_month(clev, target_month_end, panel))
    except Exception:
        pass

    x_inf = pd.Series(feats).reindex(cols).fillna(X.median(numeric_only=True)).fillna(0.0)
    mid, lo_mom, hi_mom = _predict_with_bands(pipe, x_inf, cols, resid_std)
    mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(mid, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(lo_mom, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(hi_mom, last_cpi, target_month_end, cpi)

    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return SplineNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        n_spline_feats=len(spline_cols),
        n_train_rows=int(len(X)),
    )
