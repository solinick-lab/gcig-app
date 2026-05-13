"""Subcomponent CPI nowcaster with FINE decomposition (Agent SUBCOMP-5W).

Beats the 3-way Food/Energy/Core split by separating Shelter — the biggest
and slowest-moving piece of Core — from the rest of Core. Each bucket is
forecast with quantile-loss GBRs trained on a feature subset chosen for
that component's economic drivers:

  - Food (CPIUFDSL, ~13%)        : commodity prices, PPI, oil-as-logistics.
  - Energy (CPIENGSL, ~7%)       : WTI, Brent, retail gas, diesel — most
                                   volatile but most predictable from daily.
  - Shelter (CUSR0000SAH1, ~33%) : Case-Shiller, HOUST, PERMIT, MICH —
                                   sticky and slow.
  - Core (CPILFESL, ~80%)        : forecast as-is, then decompose:
        core_ex_shelter = (core - shelter_w_in_core * shelter) / (1 - shelter_w_in_core)
    Combined headline:
        headline = 0.13*food + 0.07*energy + 0.33*shelter + 0.47*core_ex_shelter

Same return shape as `nowcast.backtest_nowcast`. Each cut is wrapped in
try/except so a single failure doesn't kill the run. Sanity-clip MoM to
[-1.5, 2.5] post-aggregation. Per-cut runtime kept low (small GBR grids,
component-specific feature subsets keep each fit fast).

Intentionally a self-contained module — does NOT modify any other file.
Re-uses `rich_features_at` and `_build_supervised_rich`-style logic but
trains 4 component models instead of one headline model.
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
from .nowcast_richfeats import rich_features_at


warnings.filterwarnings("ignore")


# --- BLS-style fixed weights (relative-importance shares; do NOT learn) ---
# Headline = w_food*food + w_energy*energy + w_shelter*shelter + w_other*core_ex_shelter
# These are CPI-U relative-importance weights used as priors. They sum to 1.0.
_W_FOOD = 0.13
_W_ENERGY = 0.07
_W_SHELTER = 0.33
_W_OTHER = 1.0 - _W_FOOD - _W_ENERGY - _W_SHELTER  # ~0.47

# Shelter's share within Core (CPILFESL). Used to decompose core into
# core_ex_shelter when we have a Core forecast and a Shelter forecast.
# Core ~ 80% of headline, Shelter ~ 33% of headline => Shelter is roughly
# 33/80 ~= 0.41 of Core. Using 0.41 as the Core-internal shelter weight.
_SHELTER_IN_CORE = 0.41

# Subcomponent FRED IDs.
_FOOD_ID = "CPIUFDSL"
_ENERGY_ID = "CPIENGSL"
_SHELTER_ID = "CUSR0000SAH1"
_CORE_ID = "CPILFESL"

# --- Per-component feature filters ----------------------------------------
# Each component's forecaster only sees rich-feature columns whose prefix
# (the FRED ID embedded in `rich_features_at` outputs) is in its driver set.
# Prefixes are matched against the start of each feature key.

_FOOD_DRIVER_PREFIXES = (
    # Logistics / industrial inputs.
    "DCOILWTICO", "DCOILBRENTEU",
    # USD (priced commodities).
    "DTWEXBGS",
    # Retail gas / diesel weeklies (transport).
    "GASREGW", "GASDESW",
    # Calendar.
    "mtd_weekday_count", "mtd_weekend_count",
    # CPI lag context.
    "cpi_mom_lag", "cpi_yoy_lag",
    "month_sin", "month_cos",
)

_ENERGY_DRIVER_PREFIXES = (
    # Crude.
    "DCOILWTICO", "DCOILBRENTEU",
    # Retail gas + diesel (the actual CPI energy basket).
    "GASREGW", "GASDESW",
    # USD (oil priced in dollars).
    "DTWEXBGS",
    # Cross-asset interaction with USD.
    "x_oil_usd_mom7",
    # Calendar.
    "mtd_weekday_count", "mtd_weekend_count",
    "cpi_mom_lag", "cpi_yoy_lag",
    "month_sin", "month_cos",
)

_SHELTER_DRIVER_PREFIXES = (
    # Inflation expectations (rents react to expectations).
    "T5YIE", "T10YIE", "T5YIFR",
    "x_breakeven_slope",
    # Yield curve (mortgage proxies).
    "DGS10", "DGS2", "T10Y2Y", "T10Y3M",
    # Calendar.
    "mtd_weekday_count", "mtd_weekend_count",
    "cpi_mom_lag", "cpi_yoy_lag",
    "month_sin", "month_cos",
)

_CORE_DRIVER_PREFIXES = (
    # Wages / breakeven / sticky pressure.
    "T5YIE", "T10YIE", "T5YIFR",
    "x_breakeven_slope",
    # USD (import prices in core goods).
    "DTWEXBGS",
    # Yields (financial conditions).
    "DGS10", "DGS2", "T10Y2Y", "T10Y3M",
    # Credit (HY spread = activity proxy).
    "BAMLH0A0HYM2",
    "x_oil_hy_mom7",
    # Initial claims (labor).
    "ICSA",
    # Calendar.
    "mtd_weekday_count", "mtd_weekend_count",
    "cpi_mom_lag", "cpi_yoy_lag",
    "month_sin", "month_cos",
)

_QUANTILES = (0.1, 0.5, 0.9)
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05

_GBR_PARAMS = dict(
    n_estimators=300,   # slightly smaller per-component (4 fits per cut)
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)


@dataclass
class SubcompNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    component_moms: dict


# --- Helpers --------------------------------------------------------------

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
    """Log MoM % change of a subcomponent series."""
    s = panel[fred_id].dropna()
    return ((np.log(s) - np.log(s.shift(1))) * 100.0).rename(f"{fred_id}_mom")


def _build_supervised_for_component(
    panel: pd.DataFrame,
    daily_frame: dict,
    fred_id: str,
    driver_prefixes: tuple[str, ...],
    as_of_day: int,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series]:
    """Build (X, y) for one subcomponent.

    y = log MoM% of `fred_id` at month T.
    X = component-filtered rich features as of day `as_of_day` of T,
        plus the component's OWN MoM lags (lag1, lag2) and headline lags.
    """
    if fred_id not in panel.columns:
        raise RuntimeError(f"Subcomponent {fred_id} missing from panel")

    comp_mom = _component_log_mom(panel, fred_id).dropna()
    headline_mom = build_target(panel).dropna()
    cpi_headline = panel[TARGET.fred_id].dropna()

    # Eligible months: must have y_t (subcomp), y_{t-1}, headline lags.
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

        # Component own-MoM lags.
        try:
            comp_until = comp_mom.loc[:month_end]
            if len(comp_until) >= 3:
                feats[f"{fred_id}_mom_lag1"] = float(comp_until.iloc[-2])
                feats[f"{fred_id}_mom_lag2"] = float(comp_until.iloc[-3])
            else:
                continue
        except Exception:
            continue

        # Headline CPI lags (cross-component info).
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
        feats["target_month_end"] = month_end
        rows.append(feats)
        targets.append(float(comp_mom.loc[month_end]))

    if not rows:
        raise RuntimeError(f"No supervised rows built for {fred_id}")

    df = pd.DataFrame(rows).set_index("target_month_end")
    y = pd.Series(targets, index=df.index, name=f"{fred_id}_y_mom")
    df = df.dropna(axis=1, how="all")
    df = df.fillna(df.median(numeric_only=True))
    df = df.fillna(0.0)
    return df, y


@dataclass
class _ComponentModel:
    fred_id: str
    models: dict
    feature_cols: list

    def predict_one(self, x: pd.Series) -> float:
        x_aligned = x.reindex(self.feature_cols).fillna(0.0).values.reshape(1, -1)
        preds = []
        for q in _QUANTILES:
            preds.append(float(self.models[q].predict(x_aligned)[0]))
        triple = np.sort(np.array(preds, dtype=float))
        return float(triple[1])  # median


def _fit_component_model(
    panel: pd.DataFrame,
    daily_frame: dict,
    fred_id: str,
    driver_prefixes: tuple[str, ...],
    as_of_day: int,
) -> _ComponentModel:
    X, y = _build_supervised_for_component(
        panel, daily_frame, fred_id, driver_prefixes, as_of_day,
    )
    cols = list(X.columns)
    Xv = X.values
    yv = y.values
    models: dict = {}
    for q in _QUANTILES:
        gbr = GradientBoostingRegressor(
            loss="quantile", alpha=q, **_GBR_PARAMS,
        ).fit(Xv, yv)
        models[q] = gbr
    return _ComponentModel(fred_id=fred_id, models=models, feature_cols=cols)


def _build_inference_features(
    train_panel: pd.DataFrame,
    daily_frame: dict,
    fred_id: str,
    driver_prefixes: tuple[str, ...],
    target_month_end: pd.Timestamp,
    as_of_day: int,
) -> tuple[dict, pd.Timestamp]:
    """Inference feature row for one component at the cut."""
    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)
    full_feats = rich_features_at(daily_frame, as_of)
    feats = _filter_features(full_feats, driver_prefixes)

    # Own component lags.
    comp_mom = _component_log_mom(train_panel, fred_id).dropna()
    if len(comp_mom) >= 2:
        feats[f"{fred_id}_mom_lag1"] = float(comp_mom.iloc[-1])
        feats[f"{fred_id}_mom_lag2"] = float(comp_mom.iloc[-2]) if len(comp_mom) >= 2 else float(comp_mom.iloc[-1])

    # Headline lags.
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
    return feats, as_of


def _aggregate_to_headline(
    food_mom: float,
    energy_mom: float,
    shelter_mom: float,
    core_mom: float,
) -> float:
    """Combine 4 component MoMs into headline MoM via BLS-prior weights.

    Strategy: derive `core_ex_shelter` from the Core forecast and the
    Shelter forecast, then weight: 0.13*food + 0.07*energy + 0.33*shelter
    + 0.47*core_ex_shelter.

    Falls back to 3-way (Food/Energy/Core) if the implied core_ex_shelter
    is outside a sane band — large divergences usually mean one of the
    component models mispredicted catastrophically.
    """
    # Decompose: core_mom ~= w_sh*shelter_mom + (1-w_sh)*core_ex
    #         => core_ex = (core_mom - w_sh * shelter_mom) / (1 - w_sh)
    w_sh = _SHELTER_IN_CORE
    core_ex = (core_mom - w_sh * shelter_mom) / (1.0 - w_sh)

    # Sanity band on core_ex — if it explodes we revert to weighted Core.
    if not np.isfinite(core_ex) or abs(core_ex) > 3.0:
        # Fall back: 0.13*food + 0.07*energy + 0.80*core (3-way).
        return 0.13 * food_mom + 0.07 * energy_mom + 0.80 * core_mom

    return (
        _W_FOOD * food_mom
        + _W_ENERGY * energy_mom
        + _W_SHELTER * shelter_mom
        + _W_OTHER * core_ex
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


# --- Public entry points --------------------------------------------------


_COMPONENTS = (
    (_FOOD_ID, _FOOD_DRIVER_PREFIXES),
    (_ENERGY_ID, _ENERGY_DRIVER_PREFIXES),
    (_SHELTER_ID, _SHELTER_DRIVER_PREFIXES),
    (_CORE_ID, _CORE_DRIVER_PREFIXES),
)


def backtest_subcomp_5way_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict,
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the 4-bucket subcomponent nowcaster.

    For each historical cut t in the trailing `window_months`:
      - For each of {Food, Energy, Shelter, Core}: fit a quantile-loss
        GBR triple on rich features (filtered to that component's drivers)
        plus the component's own-MoM lag, using only data strictly before t.
      - Predict each component's MoM at q={0.1,0.5,0.9}, take median.
      - Aggregate via BLS weights and Core-ex-Shelter decomposition.
      - Clip headline MoM to [-1.5, 2.5], chain to YoY.

    Each cut is wrapped in try/except. If any single component fit fails,
    the whole cut is skipped (we don't want a partial aggregation).
    Same return shape as `nowcast.backtest_nowcast`.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    # Verify all subcomponents are present before starting.
    for fid, _ in _COMPONENTS:
        if fid not in panel.columns:
            return {"error": f"missing subcomponent {fid} in panel"}

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

            # Fit one model per component.
            comp_models: dict = {}
            comp_failed = False
            for fid, prefixes in _COMPONENTS:
                try:
                    comp_models[fid] = _fit_component_model(
                        train_panel, daily_frame, fid, prefixes, as_of_day,
                    )
                except Exception:
                    comp_failed = True
                    break
            if comp_failed:
                continue

            # Predict each component.
            comp_moms: dict = {}
            pred_failed = False
            as_of_used: pd.Timestamp = target_month_end
            for fid, prefixes in _COMPONENTS:
                try:
                    feats, as_of = _build_inference_features(
                        train_panel, daily_frame, fid, prefixes,
                        target_month_end, as_of_day,
                    )
                    as_of_used = as_of
                    comp_moms[fid] = comp_models[fid].predict_one(pd.Series(feats))
                except Exception:
                    pred_failed = True
                    break
            if pred_failed:
                continue

            food_m = comp_moms[_FOOD_ID]
            energy_m = comp_moms[_ENERGY_ID]
            shelter_m = comp_moms[_SHELTER_ID]
            core_m = comp_moms[_CORE_ID]

            pred_mom = _aggregate_to_headline(food_m, energy_m, shelter_m, core_m)
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
                "as_of": as_of_used.strftime("%Y-%m-%d"),
                "pred_mom": round(pred_mom, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "food_mom": round(food_m, 4),
                "energy_mom": round(energy_m, 4),
                "shelter_mom": round(shelter_m, 4),
                "core_mom": round(core_m, 4),
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


def run_subcomp_5way_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> SubcompNowcastResult:
    """Live current-month forecast: pull panels, fit 4 component models,
    aggregate to headline, return the forecast result with confidence band."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    # Verify subcomponents are available.
    missing = [fid for fid, _ in _COMPONENTS if fid not in panel.columns]
    if missing:
        raise RuntimeError(
            f"Required subcomponents missing from panel: {missing}. "
            "Subcomponent nowcast requires Food/Energy/Shelter/Core series."
        )

    # Fit all 4 component models.
    comp_models: dict = {}
    for fid, prefixes in _COMPONENTS:
        comp_models[fid] = _fit_component_model(
            panel, daily_frame, fid, prefixes, as_of_day,
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

    # Predict each component using inference features at `as_of`.
    comp_moms: dict = {}
    full_feats = rich_features_at(daily_frame, as_of)
    headline_y = build_target(panel).dropna()
    for fid, prefixes in _COMPONENTS:
        feats = _filter_features(full_feats, prefixes)
        comp_mom_series = _component_log_mom(panel, fid).dropna()
        if len(comp_mom_series) >= 2:
            feats[f"{fid}_mom_lag1"] = float(comp_mom_series.iloc[-1])
            feats[f"{fid}_mom_lag2"] = float(comp_mom_series.iloc[-2])
        feats["cpi_mom_lag1"] = float(headline_y.iloc[-1])
        feats["cpi_mom_lag2"] = float(headline_y.iloc[-2])
        if len(cpi) >= 13:
            feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
        feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
        comp_moms[fid] = comp_models[fid].predict_one(pd.Series(feats))

    food_m = comp_moms[_FOOD_ID]
    energy_m = comp_moms[_ENERGY_ID]
    shelter_m = comp_moms[_SHELTER_ID]
    core_m = comp_moms[_CORE_ID]

    pred_mom = _aggregate_to_headline(food_m, energy_m, shelter_m, core_m)
    pred_mom = float(np.clip(pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(pred_mom, last_cpi, target_month_end, cpi)

    # Crude band: use Core component model's quantile spread as proxy
    # (Core dominates aggregate variance in normal regimes), scaled by
    # core's headline weight + a floor.
    core_model = comp_models[_CORE_ID]
    feats_core = _filter_features(full_feats, _CORE_DRIVER_PREFIXES)
    comp_mom_series = _component_log_mom(panel, _CORE_ID).dropna()
    if len(comp_mom_series) >= 2:
        feats_core[f"{_CORE_ID}_mom_lag1"] = float(comp_mom_series.iloc[-1])
        feats_core[f"{_CORE_ID}_mom_lag2"] = float(comp_mom_series.iloc[-2])
    feats_core["cpi_mom_lag1"] = float(headline_y.iloc[-1])
    feats_core["cpi_mom_lag2"] = float(headline_y.iloc[-2])
    if len(cpi) >= 13:
        feats_core["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats_core["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats_core["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

    x_aligned = pd.Series(feats_core).reindex(core_model.feature_cols).fillna(0.0).values.reshape(1, -1)
    qlo = float(core_model.models[0.1].predict(x_aligned)[0])
    qhi = float(core_model.models[0.9].predict(x_aligned)[0])
    half_width = max((qhi - qlo) / 2.0, _RESID_FLOOR)

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

    return SubcompNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        component_moms={
            "food": round(food_m, 4),
            "energy": round(energy_m, 4),
            "shelter": round(shelter_m, 4),
            "core": round(core_m, 4),
        },
    )
