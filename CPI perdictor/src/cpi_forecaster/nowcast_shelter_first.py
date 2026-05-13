"""Hierarchical SHELTER-FIRST nowcaster (Agent SHELTER-FIRST).

Big idea: Shelter is ~33% of CPI — the single largest component, and it
is ALSO the slowest-moving and most lead-able piece (BLS' rent surveys
lag market rents by 6-12 months). Standard headline-direct nowcasters
dilute the rent signal in a sea of unrelated daily features. This module
gives shelter a DEDICATED forecaster with Zillow ZORI as the primary
driver, then forecasts Food and Energy separately, and treats Other-Core
as a residual after subtracting the three explicit pieces.

Architecture (mirrors `nowcast_subcomp_5way` but Zillow-special-cased
for shelter, and the residual decomposition is inverted — instead of
forecasting Core and decomposing into core_ex_shelter, we forecast
Other-Core directly as a residual):

  - Shelter forecaster:
        target = CUSR0000SAH1 MoM
        features = ZORI lag 0/6/12/18 (YoY+MoM) + CSUSHPISA YoY + HOUST
                   + PERMIT MoM + own MoM lags + breakevens + DGS10
  - Food forecaster:
        target = CPIUFDSL MoM
        features = WTI / Brent / USD / retail gas / diesel + own lags
  - Energy forecaster:
        target = CPIENGSL MoM
        features = WTI / Brent / retail gas / diesel + USD interaction
  - Other-Core (residual) forecaster:
        target = headline_mom - 0.13*food_actual - 0.07*energy_actual
                 - 0.33*shelter_actual   (BLS prior weights)
        features = wages (CES0500000003) + MICH + USD + sticky CPI
                   + breakevens + claims + own lag

Aggregate:
  headline = 0.13*food + 0.07*energy + 0.33*shelter + 0.47*other_core

Sanity-clip headline MoM to [-1.5, 2.5] post-aggregation. Each cut is
wrapped in try/except.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor

from .api_client import get_daily_panel, get_zillow_rent
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame
from .nowcast_richfeats import rich_features_at
from .nowcast_zillow import (
    _safe_get_zillow,
    _zillow_history_to_series,
    _zillow_features_for_month,
)


warnings.filterwarnings("ignore")


# --- BLS-style prior weights (CPI-U relative-importance shares) -----------
_W_FOOD = 0.13
_W_ENERGY = 0.07
_W_SHELTER = 0.33
_W_OTHER = 1.0 - _W_FOOD - _W_ENERGY - _W_SHELTER  # ~0.47

# Subcomponent FRED IDs.
_FOOD_ID = "CPIUFDSL"
_ENERGY_ID = "CPIENGSL"
_SHELTER_ID = "CUSR0000SAH1"

# Monthly panel series we use as shelter / other-core features.
_CASE_SHILLER = "CSUSHPISA"
_HOUST = "HOUST"
_PERMIT = "PERMIT"
_MICH = "MICH"
_STICKY = "STICKCPIM157SFRBATL"
_WAGES = "CES0500000003"


# --- Per-component feature filters (rich-feature prefix lists) ------------

# Food: oil priced in USD as a logistics input + retail gas/diesel + USD.
_FOOD_DRIVER_PREFIXES = (
    "DCOILWTICO", "DCOILBRENTEU",
    "DTWEXBGS",
    "GASREGW", "GASDESW",
    "mtd_weekday_count", "mtd_weekend_count",
    "cpi_mom_lag", "cpi_yoy_lag",
    "month_sin", "month_cos",
)

# Energy: crude + retail gas/diesel + USD + cross-asset oil*USD.
_ENERGY_DRIVER_PREFIXES = (
    "DCOILWTICO", "DCOILBRENTEU",
    "GASREGW", "GASDESW",
    "DTWEXBGS",
    "x_oil_usd_mom7",
    "mtd_weekday_count", "mtd_weekend_count",
    "cpi_mom_lag", "cpi_yoy_lag",
    "month_sin", "month_cos",
)

# Shelter: yields (mortgage proxy) + breakevens; the heavy lifting is
# done by the explicit Zillow / Case-Shiller / HOUST features added
# separately below.
_SHELTER_DRIVER_PREFIXES = (
    "T5YIE", "T10YIE", "T5YIFR",
    "x_breakeven_slope",
    "DGS10", "DGS2", "T10Y2Y", "T10Y3M",
    "mtd_weekday_count", "mtd_weekend_count",
    "month_sin", "month_cos",
)

# Other-core (residual): wages + USD + breakevens + credit + claims.
_OTHER_DRIVER_PREFIXES = (
    "T5YIE", "T10YIE", "T5YIFR",
    "x_breakeven_slope",
    "DTWEXBGS",
    "DGS10", "DGS2", "T10Y2Y", "T10Y3M",
    "BAMLH0A0HYM2",
    "x_oil_hy_mom7",
    "ICSA",
    "mtd_weekday_count", "mtd_weekend_count",
    "cpi_mom_lag", "cpi_yoy_lag",
    "month_sin", "month_cos",
)

_QUANTILES = (0.1, 0.5, 0.9)
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05

_GBR_PARAMS = dict(
    n_estimators=300,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)


@dataclass
class ShelterFirstNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_zillow_scrape: bool
    zillow_source: str | None
    component_moms: dict


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _filter_features(feats: dict, prefixes: tuple[str, ...]) -> dict:
    """Keep only feature keys whose name starts with any allowed prefix."""
    out = {}
    for k, v in feats.items():
        for p in prefixes:
            if k.startswith(p) or k == p:
                out[k] = v
                break
    return out


def _component_log_mom(panel: pd.DataFrame, fred_id: str) -> pd.Series:
    s = panel[fred_id].dropna()
    return ((np.log(s) - np.log(s.shift(1))) * 100.0).rename(f"{fred_id}_mom")


def _safe_value(panel: pd.DataFrame, fred_id: str, month_end: pd.Timestamp) -> float:
    """Latest value of a panel series strictly <= month_end (or NaN)."""
    if fred_id not in panel.columns:
        return float("nan")
    s = panel[fred_id].dropna()
    s = s.loc[s.index <= month_end]
    if len(s) == 0:
        return float("nan")
    return float(s.iloc[-1])


def _safe_yoy(panel: pd.DataFrame, fred_id: str, month_end: pd.Timestamp) -> float:
    if fred_id not in panel.columns:
        return float("nan")
    s = panel[fred_id].dropna()
    s = s.loc[s.index <= month_end]
    if len(s) < 13:
        return float("nan")
    try:
        return float((s.iloc[-1] / s.iloc[-13] - 1.0) * 100.0)
    except Exception:
        return float("nan")


def _safe_mom(panel: pd.DataFrame, fred_id: str, month_end: pd.Timestamp) -> float:
    if fred_id not in panel.columns:
        return float("nan")
    s = panel[fred_id].dropna()
    s = s.loc[s.index <= month_end]
    if len(s) < 2:
        return float("nan")
    try:
        return float((np.log(s.iloc[-1]) - np.log(s.iloc[-2])) * 100.0)
    except Exception:
        return float("nan")


def _shelter_panel_features(
    panel: pd.DataFrame,
    cutoff_month_end: pd.Timestamp,
) -> dict[str, float]:
    """Add Case-Shiller / HOUST / PERMIT features (panel-monthly) for the
    shelter forecaster. Only sees data published <= cutoff_month_end.

    The cutoff is the END of the month BEFORE the target — i.e. data we'd
    actually have when forecasting target_month_end.
    """
    out: dict[str, float] = {}
    out["csushpisa_yoy"] = _safe_yoy(panel, _CASE_SHILLER, cutoff_month_end)
    out["csushpisa_mom"] = _safe_mom(panel, _CASE_SHILLER, cutoff_month_end)
    out["houst_level"] = _safe_value(panel, _HOUST, cutoff_month_end)
    out["houst_yoy"] = _safe_yoy(panel, _HOUST, cutoff_month_end)
    out["permit_level"] = _safe_value(panel, _PERMIT, cutoff_month_end)
    out["permit_mom"] = _safe_mom(panel, _PERMIT, cutoff_month_end)
    return out


def _other_core_panel_features(
    panel: pd.DataFrame,
    cutoff_month_end: pd.Timestamp,
) -> dict[str, float]:
    """Wages / MICH / sticky-CPI features for the other-core residual."""
    out: dict[str, float] = {}
    out["wages_yoy"] = _safe_yoy(panel, _WAGES, cutoff_month_end)
    out["wages_mom"] = _safe_mom(panel, _WAGES, cutoff_month_end)
    out["mich_level"] = _safe_value(panel, _MICH, cutoff_month_end)
    out["sticky_level"] = _safe_value(panel, _STICKY, cutoff_month_end)
    out["sticky_mom"] = _safe_mom(panel, _STICKY, cutoff_month_end)
    return out


def _zillow_lag18(zori_df: pd.DataFrame | None, target_month_end: pd.Timestamp) -> float:
    """Add an 18-month-lag YoY feature beyond what `_zillow_features_for_month`
    already provides (lags 0/6/12). 18m lag is closer to the end of BLS'
    catch-up window for renewal leases."""
    if zori_df is None or zori_df.empty:
        return float("nan")
    cutoff = target_month_end + pd.offsets.MonthEnd(-1)
    avail = zori_df.loc[zori_df.index <= cutoff]
    if len(avail) < 19:
        return float("nan")
    try:
        v = avail.iloc[-19].get("yoy", float("nan"))
        return float(v) if np.isfinite(v) else float("nan")
    except Exception:
        return float("nan")


# ---------------------------------------------------------------------------
# Supervised dataset construction (per component)
# ---------------------------------------------------------------------------


def _build_supervised_for_component(
    panel: pd.DataFrame,
    daily_frame: dict,
    fred_id: str | None,  # None for the residual "other_core"
    driver_prefixes: tuple[str, ...],
    as_of_day: int,
    *,
    is_shelter: bool = False,
    is_other_core: bool = False,
    zori_df: pd.DataFrame | None = None,
    zori_is_scrape: bool = False,
    food_actual_mom: pd.Series | None = None,
    energy_actual_mom: pd.Series | None = None,
    shelter_actual_mom: pd.Series | None = None,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series]:
    """Build (X, y) for one component.

    For non-residual components: y = log MoM% of `fred_id`.
    For other_core (is_other_core=True): y = headline_mom - w_food*food
                                              - w_energy*energy - w_shelter*shelter
    """
    headline_mom = build_target(panel).dropna()
    cpi_headline = panel[TARGET.fred_id].dropna()

    if is_other_core:
        # Need actual food/energy/shelter MoM to construct the residual target.
        if food_actual_mom is None or energy_actual_mom is None or shelter_actual_mom is None:
            raise RuntimeError("residual target requires food/energy/shelter actual MoM")
        eligible_months = headline_mom.index[min_history_months:]
    else:
        if fred_id is None or fred_id not in panel.columns:
            raise RuntimeError(f"Subcomponent {fred_id} missing from panel")
        comp_mom = _component_log_mom(panel, fred_id).dropna()
        eligible_months = comp_mom.index[min_history_months:]

    rows: list[dict] = []
    targets: list[float] = []
    for month_end in eligible_months:
        m_start = month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)

        try:
            full_feats = rich_features_at(daily_frame, as_of)
        except Exception:
            continue

        feats = _filter_features(full_feats, driver_prefixes)

        cutoff = month_end + pd.offsets.MonthEnd(-1)

        # Component own-MoM lags (only for non-residual subcomponents).
        if not is_other_core:
            try:
                comp_until = comp_mom.loc[:month_end]
                if len(comp_until) >= 3:
                    feats[f"{fred_id}_mom_lag1"] = float(comp_until.iloc[-2])
                    feats[f"{fred_id}_mom_lag2"] = float(comp_until.iloc[-3])
                else:
                    continue
            except Exception:
                continue

        # Headline lags (cross-component info — useful for all forecasters).
        try:
            head_until = headline_mom.loc[:month_end]
            feats["cpi_mom_lag1"] = float(head_until.iloc[-2])
            if len(head_until) >= 3:
                feats["cpi_mom_lag2"] = float(head_until.iloc[-3])
        except Exception:
            pass

        try:
            cpi_until = cpi_headline.loc[:month_end]
            if len(cpi_until) >= 14:
                feats["cpi_yoy_lag1"] = float(
                    (cpi_until.iloc[-2] / cpi_until.iloc[-14] - 1.0) * 100.0
                )
        except Exception:
            pass

        feats["month_sin"] = float(np.sin(2 * np.pi * month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * month_end.month / 12.0))

        # Shelter-specific feature additions.
        if is_shelter:
            try:
                feats.update(_shelter_panel_features(panel, cutoff))
            except Exception:
                pass
            try:
                z_feats = _zillow_features_for_month(
                    zori_df, month_end, zori_is_scrape,
                )
                feats.update(z_feats)
                feats["zori_yoy_lag18"] = _zillow_lag18(zori_df, month_end)
            except Exception:
                pass

        if is_other_core:
            try:
                feats.update(_other_core_panel_features(panel, cutoff))
            except Exception:
                pass

        # Target.
        if is_other_core:
            try:
                hd = float(headline_mom.loc[month_end])
                f_act = (
                    float(food_actual_mom.loc[month_end])
                    if month_end in food_actual_mom.index else np.nan
                )
                e_act = (
                    float(energy_actual_mom.loc[month_end])
                    if month_end in energy_actual_mom.index else np.nan
                )
                s_act = (
                    float(shelter_actual_mom.loc[month_end])
                    if month_end in shelter_actual_mom.index else np.nan
                )
                if not (np.isfinite(f_act) and np.isfinite(e_act) and np.isfinite(s_act)):
                    continue
                resid = hd - _W_FOOD * f_act - _W_ENERGY * e_act - _W_SHELTER * s_act
                # other_core implied per-unit (residual / W_OTHER)
                tgt = resid / _W_OTHER
            except Exception:
                continue
            targets.append(tgt)
        else:
            try:
                targets.append(float(comp_mom.loc[month_end]))
            except Exception:
                continue

        feats["target_month_end"] = month_end
        rows.append(feats)

    if not rows:
        raise RuntimeError("No supervised rows built for component")

    df = pd.DataFrame(rows).set_index("target_month_end")
    y = pd.Series(targets, index=df.index, name="y_mom")
    df = df.dropna(axis=1, how="all")
    df = df.fillna(df.median(numeric_only=True))
    df = df.fillna(0.0)
    return df, y


# ---------------------------------------------------------------------------
# Component model
# ---------------------------------------------------------------------------


@dataclass
class _ComponentModel:
    name: str
    models: dict
    feature_cols: list

    def predict_one(self, x: pd.Series) -> float:
        x_aligned = x.reindex(self.feature_cols).fillna(0.0).values.reshape(1, -1)
        preds = []
        for q in _QUANTILES:
            preds.append(float(self.models[q].predict(x_aligned)[0]))
        triple = np.sort(np.array(preds, dtype=float))
        return float(triple[1])  # median

    def predict_band(self, x: pd.Series) -> tuple[float, float, float]:
        x_aligned = x.reindex(self.feature_cols).fillna(0.0).values.reshape(1, -1)
        preds = sorted(float(self.models[q].predict(x_aligned)[0]) for q in _QUANTILES)
        return preds[1], preds[0], preds[2]


def _fit_component_quantile_models(X: pd.DataFrame, y: pd.Series) -> dict:
    models: dict = {}
    Xv = X.values
    yv = y.values
    for q in _QUANTILES:
        gbr = GradientBoostingRegressor(
            loss="quantile", alpha=q, **_GBR_PARAMS,
        ).fit(Xv, yv)
        models[q] = gbr
    return models


# ---------------------------------------------------------------------------
# Inference feature builders
# ---------------------------------------------------------------------------


def _inference_features(
    train_panel: pd.DataFrame,
    daily_frame: dict,
    target_month_end: pd.Timestamp,
    as_of_day: int,
    driver_prefixes: tuple[str, ...],
    *,
    fred_id: str | None,
    is_shelter: bool = False,
    is_other_core: bool = False,
    zori_df: pd.DataFrame | None = None,
    zori_is_scrape: bool = False,
) -> tuple[dict, pd.Timestamp]:
    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)
    full_feats = rich_features_at(daily_frame, as_of)
    feats = _filter_features(full_feats, driver_prefixes)

    cutoff = target_month_end + pd.offsets.MonthEnd(-1)

    if not is_other_core and fred_id is not None:
        comp_mom = _component_log_mom(train_panel, fred_id).dropna()
        if len(comp_mom) >= 2:
            feats[f"{fred_id}_mom_lag1"] = float(comp_mom.iloc[-1])
            feats[f"{fred_id}_mom_lag2"] = float(comp_mom.iloc[-2])

    train_y = build_target(train_panel).dropna()
    if len(train_y) >= 2:
        feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
        feats["cpi_mom_lag2"] = float(train_y.iloc[-2])
    cpi_train = train_panel[TARGET.fred_id].dropna()
    if len(cpi_train) >= 13:
        feats["cpi_yoy_lag1"] = float(
            (cpi_train.iloc[-1] / cpi_train.iloc[-13] - 1.0) * 100.0
        )
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

    if is_shelter:
        try:
            feats.update(_shelter_panel_features(train_panel, cutoff))
        except Exception:
            pass
        try:
            feats.update(
                _zillow_features_for_month(zori_df, target_month_end, zori_is_scrape)
            )
            feats["zori_yoy_lag18"] = _zillow_lag18(zori_df, target_month_end)
        except Exception:
            pass

    if is_other_core:
        try:
            feats.update(_other_core_panel_features(train_panel, cutoff))
        except Exception:
            pass

    return feats, as_of


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def _aggregate_to_headline(
    food_mom: float,
    energy_mom: float,
    shelter_mom: float,
    other_core_mom: float,
) -> float:
    """Combine component MoMs into headline via BLS-prior weights."""
    return (
        _W_FOOD * food_mom
        + _W_ENERGY * energy_mom
        + _W_SHELTER * shelter_mom
        + _W_OTHER * other_core_mom
    )


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
# Public API: backtest
# ---------------------------------------------------------------------------


def backtest_shelter_first_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict,
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the shelter-first hierarchical nowcaster.

    For each historical cut t in the trailing `window_months`:
      - Fit Food / Energy / Shelter / Other-Core forecasters using only
        data strictly before t.
      - Predict each component's MoM, aggregate via BLS weights, clip,
        chain to YoY.
    Each cut is wrapped in try/except. Same return shape as
    `nowcast.backtest_nowcast`.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    # Verify required subcomponents.
    for fid in (_FOOD_ID, _ENERGY_ID, _SHELTER_ID):
        if fid not in panel.columns:
            return {"error": f"missing subcomponent {fid} in panel"}

    # One-off scrape: Zillow ZORI history (covers all cuts).
    zori = _safe_get_zillow()
    zori_df = _zillow_history_to_series(zori)
    used_zillow = bool(
        isinstance(zori, dict)
        and zori.get("ok")
        and zori_df is not None
        and not zori.get("usedFallback", False)
    )
    zillow_source = zori.get("source") if isinstance(zori, dict) else None

    # Pre-compute component MoM panels (needed for residual target).
    food_mom_full = _component_log_mom(panel, _FOOD_ID).dropna()
    energy_mom_full = _component_log_mom(panel, _ENERGY_ID).dropna()
    shelter_mom_full = _component_log_mom(panel, _SHELTER_ID).dropna()

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

            # Train-time component series (slice to strictly before t).
            train_food_mom = food_mom_full.loc[food_mom_full.index < target_month_end]
            train_energy_mom = energy_mom_full.loc[energy_mom_full.index < target_month_end]
            train_shelter_mom = shelter_mom_full.loc[shelter_mom_full.index < target_month_end]

            # Fit each component model.
            try:
                X_f, y_f = _build_supervised_for_component(
                    train_panel, daily_frame, _FOOD_ID,
                    _FOOD_DRIVER_PREFIXES, as_of_day,
                )
                food_models = _fit_component_quantile_models(X_f, y_f)
                food_mdl = _ComponentModel("food", food_models, list(X_f.columns))
            except Exception:
                continue

            try:
                X_e, y_e = _build_supervised_for_component(
                    train_panel, daily_frame, _ENERGY_ID,
                    _ENERGY_DRIVER_PREFIXES, as_of_day,
                )
                energy_models = _fit_component_quantile_models(X_e, y_e)
                energy_mdl = _ComponentModel("energy", energy_models, list(X_e.columns))
            except Exception:
                continue

            try:
                X_s, y_s = _build_supervised_for_component(
                    train_panel, daily_frame, _SHELTER_ID,
                    _SHELTER_DRIVER_PREFIXES, as_of_day,
                    is_shelter=True,
                    zori_df=zori_df,
                    zori_is_scrape=used_zillow,
                )
                shelter_models = _fit_component_quantile_models(X_s, y_s)
                shelter_mdl = _ComponentModel("shelter", shelter_models, list(X_s.columns))
            except Exception:
                continue

            try:
                X_o, y_o = _build_supervised_for_component(
                    train_panel, daily_frame, None,
                    _OTHER_DRIVER_PREFIXES, as_of_day,
                    is_other_core=True,
                    food_actual_mom=train_food_mom,
                    energy_actual_mom=train_energy_mom,
                    shelter_actual_mom=train_shelter_mom,
                )
                other_models = _fit_component_quantile_models(X_o, y_o)
                other_mdl = _ComponentModel("other_core", other_models, list(X_o.columns))
            except Exception:
                continue

            # Inference features for each component.
            try:
                feats_f, as_of = _inference_features(
                    train_panel, daily_frame, target_month_end, as_of_day,
                    _FOOD_DRIVER_PREFIXES, fred_id=_FOOD_ID,
                )
                feats_e, _ = _inference_features(
                    train_panel, daily_frame, target_month_end, as_of_day,
                    _ENERGY_DRIVER_PREFIXES, fred_id=_ENERGY_ID,
                )
                feats_s, _ = _inference_features(
                    train_panel, daily_frame, target_month_end, as_of_day,
                    _SHELTER_DRIVER_PREFIXES, fred_id=_SHELTER_ID,
                    is_shelter=True,
                    zori_df=zori_df,
                    zori_is_scrape=used_zillow,
                )
                feats_o, _ = _inference_features(
                    train_panel, daily_frame, target_month_end, as_of_day,
                    _OTHER_DRIVER_PREFIXES, fred_id=None,
                    is_other_core=True,
                )
            except Exception:
                continue

            food_m = food_mdl.predict_one(pd.Series(feats_f))
            energy_m = energy_mdl.predict_one(pd.Series(feats_e))
            shelter_m = shelter_mdl.predict_one(pd.Series(feats_s))
            other_m = other_mdl.predict_one(pd.Series(feats_o))

            pred_mom = _aggregate_to_headline(food_m, energy_m, shelter_m, other_m)
            pred_mom = float(np.clip(pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))

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
                "food_mom": round(food_m, 4),
                "energy_mom": round(energy_m, 4),
                "shelter_mom": round(shelter_m, 4),
                "other_core_mom": round(other_m, 4),
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
        "usedZillowScrape": used_zillow,
        "zillowSource": zillow_source,
        "rows": rows,
    }


# ---------------------------------------------------------------------------
# Public API: live nowcast
# ---------------------------------------------------------------------------


def run_shelter_first_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> ShelterFirstNowcastResult:
    """Live current-month forecast: pull panels, fit 4 component models
    (Food/Energy/Shelter/Other-Core with Zillow ZORI for shelter),
    aggregate to headline, return the forecast result with a band."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    # Verify subcomponents are present.
    for fid in (_FOOD_ID, _ENERGY_ID, _SHELTER_ID):
        if fid not in panel.columns:
            raise RuntimeError(
                f"Required subcomponent missing from panel: {fid}. "
                "Shelter-first nowcast requires Food/Energy/Shelter series."
            )

    # Zillow scrape (one-off).
    zori = _safe_get_zillow()
    zori_df = _zillow_history_to_series(zori)
    used_zillow = bool(
        isinstance(zori, dict)
        and zori.get("ok")
        and zori_df is not None
        and not zori.get("usedFallback", False)
    )
    zillow_source = zori.get("source") if isinstance(zori, dict) else None

    # Component MoM panels for residual target.
    food_mom_full = _component_log_mom(panel, _FOOD_ID).dropna()
    energy_mom_full = _component_log_mom(panel, _ENERGY_ID).dropna()
    shelter_mom_full = _component_log_mom(panel, _SHELTER_ID).dropna()

    # Fit models on full panel.
    X_f, y_f = _build_supervised_for_component(
        panel, daily_frame, _FOOD_ID, _FOOD_DRIVER_PREFIXES, as_of_day,
    )
    food_mdl = _ComponentModel(
        "food", _fit_component_quantile_models(X_f, y_f), list(X_f.columns),
    )

    X_e, y_e = _build_supervised_for_component(
        panel, daily_frame, _ENERGY_ID, _ENERGY_DRIVER_PREFIXES, as_of_day,
    )
    energy_mdl = _ComponentModel(
        "energy", _fit_component_quantile_models(X_e, y_e), list(X_e.columns),
    )

    X_s, y_s = _build_supervised_for_component(
        panel, daily_frame, _SHELTER_ID, _SHELTER_DRIVER_PREFIXES, as_of_day,
        is_shelter=True,
        zori_df=zori_df,
        zori_is_scrape=used_zillow,
    )
    shelter_mdl = _ComponentModel(
        "shelter", _fit_component_quantile_models(X_s, y_s), list(X_s.columns),
    )

    X_o, y_o = _build_supervised_for_component(
        panel, daily_frame, None, _OTHER_DRIVER_PREFIXES, as_of_day,
        is_other_core=True,
        food_actual_mom=food_mom_full,
        energy_actual_mom=energy_mom_full,
        shelter_actual_mom=shelter_mom_full,
    )
    other_mdl = _ComponentModel(
        "other_core", _fit_component_quantile_models(X_o, y_o), list(X_o.columns),
    )

    # Determine target month / as-of.
    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    feats_f, _ = _inference_features(
        panel, daily_frame, target_month_end, as_of_day,
        _FOOD_DRIVER_PREFIXES, fred_id=_FOOD_ID,
    )
    feats_e, _ = _inference_features(
        panel, daily_frame, target_month_end, as_of_day,
        _ENERGY_DRIVER_PREFIXES, fred_id=_ENERGY_ID,
    )
    feats_s, _ = _inference_features(
        panel, daily_frame, target_month_end, as_of_day,
        _SHELTER_DRIVER_PREFIXES, fred_id=_SHELTER_ID,
        is_shelter=True,
        zori_df=zori_df,
        zori_is_scrape=used_zillow,
    )
    feats_o, _ = _inference_features(
        panel, daily_frame, target_month_end, as_of_day,
        _OTHER_DRIVER_PREFIXES, fred_id=None,
        is_other_core=True,
    )

    food_m = food_mdl.predict_one(pd.Series(feats_f))
    energy_m = energy_mdl.predict_one(pd.Series(feats_e))
    shelter_m = shelter_mdl.predict_one(pd.Series(feats_s))
    other_m = other_mdl.predict_one(pd.Series(feats_o))

    pred_mom = _aggregate_to_headline(food_m, energy_m, shelter_m, other_m)
    pred_mom = float(np.clip(pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(pred_mom, last_cpi, target_month_end, cpi)

    # Confidence band: blend the 10/90 spread of each component, weighted
    # by its headline weight, then floor to RESID_FLOOR.
    half_widths: list[float] = []
    try:
        _, lo, hi = food_mdl.predict_band(pd.Series(feats_f))
        half_widths.append(_W_FOOD * (hi - lo) / 2.0)
    except Exception:
        pass
    try:
        _, lo, hi = energy_mdl.predict_band(pd.Series(feats_e))
        half_widths.append(_W_ENERGY * (hi - lo) / 2.0)
    except Exception:
        pass
    try:
        _, lo, hi = shelter_mdl.predict_band(pd.Series(feats_s))
        half_widths.append(_W_SHELTER * (hi - lo) / 2.0)
    except Exception:
        pass
    try:
        _, lo, hi = other_mdl.predict_band(pd.Series(feats_o))
        half_widths.append(_W_OTHER * (hi - lo) / 2.0)
    except Exception:
        pass

    half_width = float(np.sqrt(sum(hw ** 2 for hw in half_widths))) if half_widths else _RESID_FLOOR
    half_width = max(half_width, _RESID_FLOOR)

    lo_mom = pred_mom - half_width
    hi_mom = pred_mom + half_width
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

    return ShelterFirstNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_zillow_scrape=used_zillow,
        zillow_source=zillow_source,
        component_moms={
            "food": round(food_m, 4),
            "energy": round(energy_m, 4),
            "shelter": round(shelter_m, 4),
            "other_core": round(other_m, 4),
        },
    )
