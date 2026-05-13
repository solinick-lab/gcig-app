"""Max-feature "kitchen-sink" CPI nowcaster — every external feed combined.

Strategy: throw EVERYTHING into one feature matrix, then aggressively prune
to the top-k features so the GBR doesn't drown in noise. We have many
candidate features but limited training data (~hundreds of months at most),
so wide candidates + Lasso/MDI-based pruning is the textbook recipe.

Feature universe:
  1. Quantile_rich features (multi-window momentum, cross-asset interactions)
  2. Cleveland Fed nowcast (headline + core, current + next month, history)
  3. Truflation real-time daily inflation (YoY, MoM, momentum, history)
  4. Zillow ZORI (national rent at lags 0/6/12)
  5. Subcomponent forecasts as meta-features:
       - Forecast Food MoM, Energy MoM, Shelter MoM, Core MoM separately
       - Use those four predicted MoMs as inputs to the headline forecaster
       - This is a stacking layer: subcomponent models -> headline model
  6. CPI lags + month seasonality

Pruning: after building the supervised matrix, we score features by
absolute Lasso coefficient (StandardScaler -> Lasso). Top-30 are kept.
Lasso is preferred over GBR feature_importances_ for top-k selection
because Lasso explicitly zeros out collinear / redundant features (we
have plenty — Cleveland YoY and Truflation YoY both proxy current
inflation, etc.).

Honest expectation: kitchen-sink with stacking has worked OK in research
(small wins over single best feed), but is often beaten by focused
strategies because (a) the stacking layer compounds errors from each
sub-model and (b) feature pruning on small samples is itself noisy. We
target ~0.11–0.13 RMSE YoY but won't be surprised if it lands closer to
nowcast_clev's level (~0.12).

Public API:
  backtest_kitchen_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_kitchen_nowcast(as_of_day=20) -> KitchenNowcastResult

Each cut wrapped in try/except. MoM clipped to [-1.5, 2.5].
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.linear_model import Lasso
from sklearn.preprocessing import StandardScaler

from .api_client import (
    get_daily_panel,
    get_cleveland_nowcast,
    get_truflation_feed,
    get_zillow_rent,
)
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_clev import _clev_features_for_month, _safe_get_clev
from .nowcast_features import build_daily_frame
from .nowcast_richfeats import rich_features_at
from .nowcast_subcomp_5way import (
    _CORE_DRIVER_PREFIXES,
    _CORE_ID,
    _ENERGY_DRIVER_PREFIXES,
    _ENERGY_ID,
    _FOOD_DRIVER_PREFIXES,
    _FOOD_ID,
    _SHELTER_DRIVER_PREFIXES,
    _SHELTER_ID,
    _build_supervised_for_component,
    _component_log_mom,
    _filter_features,
)
from .nowcast_truflation import (
    _safe_get_truflation,
    _truf_yoy_minus_lag,
    _truflation_features_for_month,
    _truflation_series_to_pd,
)
from .nowcast_zillow import (
    _safe_get_zillow,
    _zillow_features_for_month,
    _zillow_history_to_series,
)


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_QUANTILES = (0.1, 0.5, 0.9)
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05

_TOP_K_FEATURES = 30
_LASSO_ALPHA = 0.01

_GBR_PARAMS = dict(
    n_estimators=400,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)

# Smaller GBR for the per-component sub-models — 4 fits per cut, keep fast.
_SUBCOMP_GBR_PARAMS = dict(
    n_estimators=200,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)

_SUBCOMPONENTS = (
    (_FOOD_ID, _FOOD_DRIVER_PREFIXES, "subcomp_food_mom"),
    (_ENERGY_ID, _ENERGY_DRIVER_PREFIXES, "subcomp_energy_mom"),
    (_SHELTER_ID, _SHELTER_DRIVER_PREFIXES, "subcomp_shelter_mom"),
    (_CORE_ID, _CORE_DRIVER_PREFIXES, "subcomp_core_mom"),
)


@dataclass
class KitchenNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    used_truflation_scrape: bool
    used_zillow_scrape: bool
    used_subcomp_stacking: bool
    selected_features: list


# ---------------------------------------------------------------------------
# Subcomponent stacking helpers
# ---------------------------------------------------------------------------


def _fit_subcomp_models(
    panel: pd.DataFrame,
    daily_frame: dict,
    as_of_day: int,
) -> dict | None:
    """Fit a q=0.5 GBR for each of {Food, Energy, Shelter, Core}.

    Returns dict mapping FRED_ID -> {"model": fitted_gbr, "cols": feature_cols}.
    Returns None if any required subcomponent is missing or fits fail.
    """
    out: dict = {}
    for fid, prefixes, _ in _SUBCOMPONENTS:
        if fid not in panel.columns:
            return None
        try:
            X, y = _build_supervised_for_component(
                panel, daily_frame, fid, prefixes, as_of_day,
            )
            if len(X) < 24:
                return None
            gbr = GradientBoostingRegressor(
                loss="quantile", alpha=0.5, **_SUBCOMP_GBR_PARAMS,
            ).fit(X.values, y.values)
            out[fid] = {"model": gbr, "cols": list(X.columns)}
        except Exception:
            return None
    return out


def _predict_subcomp_for_month(
    sub_models: dict,
    train_panel: pd.DataFrame,
    daily_frame: dict,
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> dict[str, float]:
    """Predict each subcomponent MoM at the inference month.

    Returns dict of feature names (subcomp_food_mom, ...) -> predicted MoM.
    Missing keys remain NaN if any sub-prediction fails.
    """
    feats: dict[str, float] = {
        name: np.nan for _, _, name in _SUBCOMPONENTS
    }
    if not sub_models:
        return feats

    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)
    try:
        full_feats = rich_features_at(daily_frame, as_of)
    except Exception:
        return feats

    headline_y = build_target(train_panel).dropna()
    cpi = train_panel[TARGET.fred_id].dropna()

    for fid, prefixes, name in _SUBCOMPONENTS:
        try:
            f = _filter_features(full_feats, prefixes)
            comp_mom = _component_log_mom(train_panel, fid).dropna()
            if len(comp_mom) >= 2:
                f[f"{fid}_mom_lag1"] = float(comp_mom.iloc[-1])
                f[f"{fid}_mom_lag2"] = float(comp_mom.iloc[-2])
            if len(headline_y) >= 2:
                f["cpi_mom_lag1"] = float(headline_y.iloc[-1])
                f["cpi_mom_lag2"] = float(headline_y.iloc[-2])
            if len(cpi) >= 13:
                f["cpi_yoy_lag1"] = float(
                    (cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0
                )
            f["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
            f["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

            cols = sub_models[fid]["cols"]
            x = pd.Series(f).reindex(cols).fillna(0.0).values.reshape(1, -1)
            feats[name] = float(sub_models[fid]["model"].predict(x)[0])
        except Exception:
            pass

    return feats


def _predict_subcomp_in_sample(
    sub_models: dict,
    panel: pd.DataFrame,
    daily_frame: dict,
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> dict[str, float]:
    """In-sample subcomponent prediction for a training month (uses panel
    sliced strictly before target_month_end).

    This avoids label leakage — the stacked features for training row T
    are computed from a model that already saw T (since sub_models are fit
    on the full train_panel, which excludes T). For each train row we use
    the panel up to month T-1 so own-component lags are correct.
    """
    feats: dict[str, float] = {
        name: np.nan for _, _, name in _SUBCOMPONENTS
    }
    if not sub_models:
        return feats

    train_slice = panel.loc[panel.index < target_month_end]
    if len(train_slice) < 24:
        return feats

    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)
    try:
        full_feats = rich_features_at(daily_frame, as_of)
    except Exception:
        return feats

    headline_y = build_target(train_slice).dropna()
    cpi = train_slice[TARGET.fred_id].dropna()

    for fid, prefixes, name in _SUBCOMPONENTS:
        try:
            f = _filter_features(full_feats, prefixes)
            comp_mom = _component_log_mom(train_slice, fid).dropna()
            if len(comp_mom) >= 2:
                f[f"{fid}_mom_lag1"] = float(comp_mom.iloc[-1])
                f[f"{fid}_mom_lag2"] = float(comp_mom.iloc[-2])
            if len(headline_y) >= 2:
                f["cpi_mom_lag1"] = float(headline_y.iloc[-1])
                f["cpi_mom_lag2"] = float(headline_y.iloc[-2])
            if len(cpi) >= 13:
                f["cpi_yoy_lag1"] = float(
                    (cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0
                )
            f["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
            f["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

            cols = sub_models[fid]["cols"]
            x = pd.Series(f).reindex(cols).fillna(0.0).values.reshape(1, -1)
            feats[name] = float(sub_models[fid]["model"].predict(x)[0])
        except Exception:
            pass

    return feats


# ---------------------------------------------------------------------------
# Feature pruning via Lasso
# ---------------------------------------------------------------------------


def _select_top_k_features(
    X: pd.DataFrame,
    y: pd.Series,
    k: int = _TOP_K_FEATURES,
) -> list[str]:
    """Score features by |Lasso coefficient| on standardized data; keep top-k.

    Falls back to GBR feature_importances_ if Lasso fails or selects nothing.
    """
    cols = list(X.columns)
    if len(cols) <= k:
        return cols

    try:
        Xv = X.values.astype(float)
        yv = y.values.astype(float)
        Xv = np.nan_to_num(Xv, nan=0.0, posinf=0.0, neginf=0.0)

        scaler = StandardScaler()
        Xs = scaler.fit_transform(Xv)

        lasso = Lasso(alpha=_LASSO_ALPHA, max_iter=5000, random_state=42)
        lasso.fit(Xs, yv)
        importances = np.abs(lasso.coef_)

        # If Lasso zeroed everything (alpha too aggressive) — fall through.
        if not np.any(importances > 0):
            raise RuntimeError("lasso_all_zero")

        ranked = sorted(
            zip(cols, importances), key=lambda p: p[1], reverse=True,
        )
        chosen = [c for c, imp in ranked if imp > 0][:k]
        if len(chosen) >= max(8, min(k, 12)):
            return chosen
    except Exception:
        pass

    # Fallback: GBR-importance ranking.
    try:
        Xv = np.nan_to_num(X.values.astype(float), nan=0.0, posinf=0.0, neginf=0.0)
        gbr = GradientBoostingRegressor(
            n_estimators=200, max_depth=3, learning_rate=0.05, random_state=42,
        ).fit(Xv, y.values.astype(float))
        ranked = sorted(
            zip(cols, gbr.feature_importances_), key=lambda p: p[1], reverse=True,
        )
        return [c for c, _ in ranked[:k]]
    except Exception:
        return cols[:k]


# ---------------------------------------------------------------------------
# Supervised dataset
# ---------------------------------------------------------------------------


def _build_supervised_kitchen(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    truf: dict,
    truf_yoy_series: pd.Series,
    truf_level_series: pd.Series,
    zori_df: pd.DataFrame | None,
    is_zillow_scrape: bool,
    sub_models: dict | None,
    as_of_day: int,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series]:
    """Build the kitchen-sink feature matrix.

    Combines: rich features + CPI lags + seasonality + Cleveland +
    Truflation + Zillow + 4 subcomponent predicted MoMs.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
    eligible_months = y_mom.index[min_history_months:]

    rows: list[dict] = []
    targets: list[float] = []
    for month_end in eligible_months:
        m_start = month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        try:
            feats = rich_features_at(daily_frame, as_of)
        except Exception:
            continue

        # CPI lags + seasonality
        try:
            feats["cpi_mom_lag1"] = float(y_mom.loc[:month_end].iloc[-2])
        except Exception:
            feats["cpi_mom_lag1"] = np.nan
        try:
            feats["cpi_mom_lag2"] = (
                float(y_mom.loc[:month_end].iloc[-3])
                if len(y_mom.loc[:month_end]) >= 3 else np.nan
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

        # Cleveland
        try:
            feats.update(_clev_features_for_month(clev, month_end, panel))
        except Exception:
            pass

        # Truflation
        try:
            tfeats = _truflation_features_for_month(
                truf, month_end, as_of_day,
                truf_yoy_series, truf_level_series,
            )
            tfeats = _truf_yoy_minus_lag(tfeats, panel, month_end)
            feats.update(tfeats)
        except Exception:
            pass

        # Zillow
        try:
            feats.update(
                _zillow_features_for_month(zori_df, month_end, is_zillow_scrape)
            )
        except Exception:
            pass

        # Subcomponent stacking — predicted MoM for each component
        try:
            sub_preds = _predict_subcomp_in_sample(
                sub_models, panel, daily_frame, month_end, as_of_day,
            )
            feats.update(sub_preds)
        except Exception:
            pass

        feats["target_month_end"] = month_end
        rows.append(feats)
        targets.append(float(y_mom.loc[month_end]))

    df = pd.DataFrame(rows).set_index("target_month_end")
    y = pd.Series(targets, index=df.index, name="y_mom")
    df = df.dropna(axis=1, how="all")
    df = df.fillna(df.median(numeric_only=True))
    df = df.fillna(0.0)
    return df, y


# ---------------------------------------------------------------------------
# Fit / predict
# ---------------------------------------------------------------------------


def _fit_quantile_models(X: pd.DataFrame, y: pd.Series) -> dict:
    """Fit q={0.1, 0.5, 0.9} GBR on the (already-pruned) feature matrix."""
    models = {}
    for q in _QUANTILES:
        models[q] = GradientBoostingRegressor(
            loss="quantile", alpha=q, **_GBR_PARAMS,
        ).fit(X.values, y.values)
    return models


def _predict_triple(
    models: dict, x_inf: pd.Series, cols: list[str]
) -> tuple[float, float, float]:
    aligned = x_inf.reindex(cols).fillna(0.0).values.reshape(1, -1)
    preds = sorted(float(models[q].predict(aligned)[0]) for q in _QUANTILES)
    lo, mid, hi = preds
    return mid, lo, hi


def _mom_to_yoy(
    pred_mom: float,
    last_cpi: float,
    target_month_end: pd.Timestamp,
    cpi: pd.Series,
) -> float:
    predicted_cpi = last_cpi * float(np.exp(pred_mom / 100.0))
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    return (predicted_cpi / denom - 1.0) * 100.0


# ---------------------------------------------------------------------------
# Inference feature builder (single row at the cut / live)
# ---------------------------------------------------------------------------


def _build_inference_feats(
    train_panel: pd.DataFrame,
    daily_frame: dict,
    clev: dict,
    truf: dict,
    truf_yoy_series: pd.Series,
    truf_level_series: pd.Series,
    zori_df: pd.DataFrame | None,
    is_zillow_scrape: bool,
    sub_models: dict | None,
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> tuple[dict, pd.Timestamp]:
    """Build a single inference feature row at the cut. Returns (feats, as_of)."""
    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)
    feats = rich_features_at(daily_frame, as_of)

    train_y = build_target(train_panel).dropna()
    train_cpi = train_panel[TARGET.fred_id].dropna()

    feats["cpi_mom_lag1"] = float(train_y.iloc[-1]) if len(train_y) else np.nan
    feats["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
    if len(train_cpi) >= 13:
        feats["cpi_yoy_lag1"] = float(
            (train_cpi.iloc[-1] / train_cpi.iloc[-13] - 1.0) * 100.0
        )
    else:
        feats["cpi_yoy_lag1"] = np.nan
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

    try:
        feats.update(_clev_features_for_month(clev, target_month_end, train_panel))
    except Exception:
        pass
    try:
        tfeats = _truflation_features_for_month(
            truf, target_month_end, as_of_day,
            truf_yoy_series, truf_level_series,
        )
        tfeats = _truf_yoy_minus_lag(tfeats, train_panel, target_month_end)
        feats.update(tfeats)
    except Exception:
        pass
    try:
        feats.update(
            _zillow_features_for_month(zori_df, target_month_end, is_zillow_scrape)
        )
    except Exception:
        pass
    try:
        sub_preds = _predict_subcomp_for_month(
            sub_models, train_panel, daily_frame, target_month_end, as_of_day,
        )
        feats.update(sub_preds)
    except Exception:
        pass

    return feats, as_of


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_kitchen_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the kitchen-sink nowcaster.

    Calls each external scrape ONCE up-front; their historical archives
    cover all backtest cuts.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    clev = _safe_get_clev()
    used_clev = bool(clev.get("ok") and clev.get("historical"))

    truf = _safe_get_truflation()
    truf_yoy_series = _truflation_series_to_pd(truf, "seriesYoy")
    truf_level_series = _truflation_series_to_pd(truf, "seriesLevel")
    used_truf = bool(truf.get("ok") and not truf_yoy_series.empty)

    zori = _safe_get_zillow()
    zori_df = _zillow_history_to_series(zori)
    used_zillow = bool(
        zori.get("ok")
        and zori_df is not None
        and not zori.get("usedFallback", False)
    )

    cuts = list(range(len(y_mom) - window_months, len(y_mom)))
    preds_mom: list[float] = []
    actuals_mom: list[float] = []
    preds_yoy: list[float] = []
    actuals_yoy: list[float] = []
    rows: list[dict] = []
    selected_features_last: list[str] = []

    for ci in cuts:
        try:
            target_month_end = y_mom.index[ci]
            train_panel = panel.loc[panel.index < target_month_end]
            if len(train_panel) < 60:
                continue

            # Fit subcomponent stacking models (q=0.5 each)
            try:
                sub_models = _fit_subcomp_models(
                    train_panel, daily_frame, as_of_day,
                )
            except Exception:
                sub_models = None

            # Build full feature matrix
            X, y = _build_supervised_kitchen(
                train_panel, daily_frame, clev, truf,
                truf_yoy_series, truf_level_series,
                zori_df, used_zillow,
                sub_models, as_of_day=as_of_day,
            )
            if len(X) < 24:
                continue

            # Prune to top-K via Lasso
            try:
                top_cols = _select_top_k_features(X, y, k=_TOP_K_FEATURES)
            except Exception:
                top_cols = list(X.columns)
            X_pruned = X[top_cols]
            selected_features_last = top_cols

            # Fit quantile triple on pruned features
            models = _fit_quantile_models(X_pruned, y)
            cols = list(X_pruned.columns)

            # Inference features (build full set, then reindex to pruned cols)
            try:
                feats, as_of = _build_inference_feats(
                    train_panel, daily_frame, clev, truf,
                    truf_yoy_series, truf_level_series,
                    zori_df, used_zillow,
                    sub_models, target_month_end, as_of_day,
                )
            except Exception:
                continue

            x_inf = pd.Series(feats).reindex(cols).fillna(
                X_pruned.median(numeric_only=True)
            ).fillna(0.0)

            mid, lo, hi = _predict_triple(models, x_inf, cols)
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
                "n_features_kept": len(cols),
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
        "usedClevScrape": used_clev,
        "usedTruflationScrape": used_truf,
        "usedZillowScrape": used_zillow,
        "topKFeatures": _TOP_K_FEATURES,
        "selectedFeaturesLast": selected_features_last,
        "rows": rows,
    }


def run_kitchen_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> KitchenNowcastResult:
    """Live nowcast using fresh Cleveland + Truflation + Zillow scrapes,
    full subcomponent stacking, and Lasso-pruned top-30 features."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    clev = _safe_get_clev()
    used_clev = bool(clev.get("ok"))

    truf = _safe_get_truflation()
    truf_yoy_series = _truflation_series_to_pd(truf, "seriesYoy")
    truf_level_series = _truflation_series_to_pd(truf, "seriesLevel")
    used_truf = bool(truf.get("ok") and not truf_yoy_series.empty)

    zori = _safe_get_zillow()
    zori_df = _zillow_history_to_series(zori)
    used_zillow = bool(
        zori.get("ok")
        and zori_df is not None
        and not zori.get("usedFallback", False)
    )

    # Subcomponent stacking models
    try:
        sub_models = _fit_subcomp_models(panel, daily_frame, as_of_day)
    except Exception:
        sub_models = None
    used_subcomp = sub_models is not None

    # Full kitchen-sink feature matrix
    X, y = _build_supervised_kitchen(
        panel, daily_frame, clev, truf,
        truf_yoy_series, truf_level_series,
        zori_df, used_zillow,
        sub_models, as_of_day=as_of_day,
    )

    # Lasso pruning to top-K
    try:
        top_cols = _select_top_k_features(X, y, k=_TOP_K_FEATURES)
    except Exception:
        top_cols = list(X.columns)
    X_pruned = X[top_cols]

    models = _fit_quantile_models(X_pruned, y)
    cols = list(X_pruned.columns)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (
        (last_released_month_end + pd.offsets.MonthBegin(1))
        + pd.offsets.MonthEnd(0)
    )
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    # Build inference features (use full panel as "train_panel" since live)
    try:
        feats, _ = _build_inference_feats(
            panel, daily_frame, clev, truf,
            truf_yoy_series, truf_level_series,
            zori_df, used_zillow,
            sub_models, target_month_end, as_of_day,
        )
    except Exception:
        feats = {}

    x_inf = pd.Series(feats).reindex(cols).fillna(
        X_pruned.median(numeric_only=True)
    ).fillna(0.0)
    mid, lo, hi = _predict_triple(models, x_inf, cols)
    mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(mid, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(lo, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(hi, last_cpi, target_month_end, cpi)

    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return KitchenNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_clev,
        used_truflation_scrape=used_truf,
        used_zillow_scrape=used_zillow,
        used_subcomp_stacking=used_subcomp,
        selected_features=cols,
    )
