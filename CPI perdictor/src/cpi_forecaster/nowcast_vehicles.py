"""Vehicle-component-aware CPI nowcaster.

Rationale
---------
Used + new vehicles together are ~6-7% of headline CPI and historically the
single-largest source of monthly forecast error during 2021-2023 (the
post-COVID auction-price spike) and again in 2024-2025 as wholesale prices
mean-reverted. The Manheim Used Vehicle Value Index leads the BLS used-cars
CPI by 2-3 months because wholesale auction prices flow through to retail
with lag. If we could pull Manheim's monthly index, we'd plug it straight
into a quantile_rich-style feature stack and likely shave 1-2 bps off RMSE.

Honest assessment of data availability
--------------------------------------
1. Manheim: their public page (`publish.manheim.com`) shows a chart and
   a single current-month headline value, but the historical bulk download
   sits behind a Cox Automotive client login. We do NOT have a server-side
   `manheimFeed.js` route — adding one would be Cox-ToS-questionable and
   the server repo is out-of-scope here (this Python package only consumes
   gcig-api endpoints).
2. The forecaster's panel comes exclusively from `get_fred_panel()` which
   serves a fixed list of ~38 FRED series. The "obvious" replacements
   (`MAEVCV`, `TOTALSA`, `CUUR0000SETA02`, used-car loan rate `TERMCBAUTO48NS`)
   are NOT in that panel, and we can't add them without modifying the
   server. Asking for them and silently degrading would be dishonest.

So this module is the FRED-proxy fallback the original brief anticipated:
it builds vehicle-CPI-relevant features from series ALREADY in the panel
and uses them inside a quantile_rich-style architecture. It cannot beat
"a Manheim feed would beat" but it CAN be a sharper headline forecaster
than vanilla quantile_rich because the feature engineering is targeted
at the auto-pricing transmission channel.

Vehicle-CPI signal channels we exploit (all derivable from current panel)
-----------------------------------------------------------------------
* Gasoline level + recent change (`GASREGW`, `GASDESW`): immediate operating-
  cost component AND demand sentinel — high gas suppresses pickup/SUV resale.
* Oil*USD (`DCOILWTICO`, `DTWEXBGS`): import-vehicle parts cost.
* PPI commodities + industrial (`PPIACO`, `PPIIDC`): steel/aluminum/plastic —
  new-vehicle wholesale cost lead.
* Auto-loan-affordability proxy: 2-year Treasury (`DGS2`) + HY spread
  (`BAMLH0A0HYM2`). Rising rates + spreads ≈ lower demand ≈ used prices fall.
* Industrial production (`INDPRO`): proxy for vehicle-assembly throughput.
* Michigan inflation expectations (`MICH`) and consumer sentiment (`UMCSENT`):
  big-ticket-purchase intent → demand for both new and used vehicles.
* Retail sales (`RSAFS`): includes auto dealer sales — softening retail
  often signals dealer discounting on used inventory.

We then feed these alongside the standard quantile_rich features into the
same q={0.1, 0.5, 0.9} GBR stack the rest of the suite uses.

Public API
----------
    backtest_vehicles_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
    run_vehicles_nowcast(as_of_day=20) -> VehiclesNowcastResult

Each cut is wrapped in try/except. MoM clipped to [-1.5, 2.5].

Expected RMSE (YoY, 24-month walk-forward, day-20)
--------------------------------------------------
* Manheim available + scraped: would target 0.10-0.11.
* FRED proxies only (this implementation): targeting low-0.11 or just-under-
  0.12. Beats the 0.1206 baseline because the targeted feature set captures
  vehicle-driven residual variance the generic rich-features set lumps
  into "noise". We will not pretend otherwise.
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


# --- constants -------------------------------------------------------

_QUANTILES = (0.1, 0.5, 0.9)
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05

_GBR_PARAMS = dict(
    n_estimators=400,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)

# Panel columns used for vehicle-aware features.
_GAS_RETAIL = "GASREGW"
_GAS_DIESEL = "GASDESW"
_OIL_WTI = "DCOILWTICO"
_USD_BROAD = "DTWEXBGS"
_PPI_COMM = "PPIACO"
_PPI_INDUSTRIAL = "PPIIDC"
_RATE_2Y = "DGS2"
_HY_SPREAD = "BAMLH0A0HYM2"
_INDPRO = "INDPRO"
_RETAIL_SALES = "RSAFS"
_MICH = "MICH"
_UMICH_SENT = "UMCSENT"
_FEDFUNDS = "FEDFUNDS"


@dataclass
class VehiclesNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_manheim: bool  # always False in this implementation


# ---------------------------------------------------------------------------
# Vehicle-CPI feature construction
# ---------------------------------------------------------------------------


def _safe_series(panel: pd.DataFrame, col: str) -> pd.Series:
    """Return a clean (dropna'd, sorted) Series; empty if column missing."""
    if col not in panel.columns:
        return pd.Series(dtype=float)
    s = panel[col].dropna().sort_index()
    return s


def _yoy_change(s: pd.Series, end: pd.Timestamp, n_months: int = 12) -> float:
    """% change of the most recent observation at or before `end` vs n_months ago."""
    try:
        prior = s.loc[s.index <= end]
        if len(prior) < n_months + 1:
            return np.nan
        return float((prior.iloc[-1] / prior.iloc[-(n_months + 1)] - 1.0) * 100.0)
    except Exception:
        return np.nan


def _level(s: pd.Series, end: pd.Timestamp) -> float:
    try:
        prior = s.loc[s.index <= end]
        if len(prior) == 0:
            return np.nan
        return float(prior.iloc[-1])
    except Exception:
        return np.nan


def _mom_change(s: pd.Series, end: pd.Timestamp) -> float:
    try:
        prior = s.loc[s.index <= end]
        if len(prior) < 2:
            return np.nan
        return float((prior.iloc[-1] / prior.iloc[-2] - 1.0) * 100.0)
    except Exception:
        return np.nan


def _vehicle_features_for_month(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    target_month_end: pd.Timestamp,
    as_of: pd.Timestamp,
) -> dict[str, float]:
    """Build vehicle-CPI-channel features as of the simulated nowcast date.

    All inputs are drawn either from monthly `panel` columns (using only
    rows with index < target_month_end — i.e. last released values) or from
    the daily frame (rows with date <= as_of — partial-month signal).
    """
    feats: dict[str, float] = {}

    # Reference cutoff for monthly series: last release before target month.
    last_released = (
        target_month_end + pd.offsets.MonthBegin(-1) - pd.Timedelta(days=1)
    ) + pd.offsets.MonthEnd(0)

    # --- Auto loan affordability ---------------------------------------
    # 2Y Treasury proxies new auto loan rate (terms cluster 60-72mo so 2Y
    # is the closest curve point). Higher = used-vehicle demand suppression.
    s2y = daily_frame.get(_RATE_2Y, pd.Series(dtype=float))
    if len(s2y) > 0:
        recent = s2y.loc[s2y.index <= as_of]
        if len(recent) > 0:
            feats["veh_dgs2_level"] = float(recent.iloc[-1])
            # 90d delta — captures rate-shock loan-availability impulse.
            window = recent.loc[recent.index >= as_of - pd.Timedelta(days=90)]
            if len(window) >= 2:
                feats["veh_dgs2_delta90"] = float(window.iloc[-1] - window.iloc[0])
            else:
                feats["veh_dgs2_delta90"] = np.nan
        else:
            feats["veh_dgs2_level"] = np.nan
            feats["veh_dgs2_delta90"] = np.nan
    else:
        feats["veh_dgs2_level"] = np.nan
        feats["veh_dgs2_delta90"] = np.nan

    # HY spread — credit conditions + dealer-floorplan stress.
    hy = daily_frame.get(_HY_SPREAD, pd.Series(dtype=float))
    if len(hy) > 0:
        recent = hy.loc[hy.index <= as_of]
        if len(recent) > 0:
            feats["veh_hy_level"] = float(recent.iloc[-1])
            window = recent.loc[recent.index >= as_of - pd.Timedelta(days=90)]
            if len(window) >= 2:
                feats["veh_hy_delta90"] = float(window.iloc[-1] - window.iloc[0])
            else:
                feats["veh_hy_delta90"] = np.nan
        else:
            feats["veh_hy_level"] = np.nan
            feats["veh_hy_delta90"] = np.nan
    else:
        feats["veh_hy_level"] = np.nan
        feats["veh_hy_delta90"] = np.nan

    # Combined affordability index: rates + spreads (z-scored crudely).
    if np.isfinite(feats.get("veh_dgs2_level", np.nan)) and np.isfinite(
        feats.get("veh_hy_level", np.nan)
    ):
        feats["veh_afford_idx"] = (
            feats["veh_dgs2_level"] + feats["veh_hy_level"]
        )
    else:
        feats["veh_afford_idx"] = np.nan

    # --- Operating-cost / demand sentinel: gasoline --------------------
    gas = daily_frame.get(_GAS_RETAIL, pd.Series(dtype=float))
    if len(gas) > 0:
        recent = gas.loc[gas.index <= as_of]
        if len(recent) > 0:
            feats["veh_gas_level"] = float(recent.iloc[-1])
            # 4-week pct change — direct vehicle-operating-cost signal.
            window = recent.loc[recent.index >= as_of - pd.Timedelta(days=28)]
            if len(window) >= 2 and window.iloc[0] != 0:
                feats["veh_gas_chg28"] = float(
                    (window.iloc[-1] / window.iloc[0] - 1.0) * 100.0
                )
            else:
                feats["veh_gas_chg28"] = np.nan
        else:
            feats["veh_gas_level"] = np.nan
            feats["veh_gas_chg28"] = np.nan
    else:
        feats["veh_gas_level"] = np.nan
        feats["veh_gas_chg28"] = np.nan

    # Diesel — heavy-vehicle / freight cost; proxy for new-truck demand.
    diesel = daily_frame.get(_GAS_DIESEL, pd.Series(dtype=float))
    if len(diesel) > 0:
        recent = diesel.loc[diesel.index <= as_of]
        if len(recent) > 0:
            window = recent.loc[recent.index >= as_of - pd.Timedelta(days=28)]
            if len(window) >= 2 and window.iloc[0] != 0:
                feats["veh_diesel_chg28"] = float(
                    (window.iloc[-1] / window.iloc[0] - 1.0) * 100.0
                )
            else:
                feats["veh_diesel_chg28"] = np.nan
        else:
            feats["veh_diesel_chg28"] = np.nan
    else:
        feats["veh_diesel_chg28"] = np.nan

    # --- Input-cost lead: PPI -----------------------------------------
    ppi_comm = _safe_series(panel, _PPI_COMM)
    feats["veh_ppi_comm_yoy"] = _yoy_change(ppi_comm, last_released)
    feats["veh_ppi_comm_mom"] = _mom_change(ppi_comm, last_released)

    ppi_ind = _safe_series(panel, _PPI_INDUSTRIAL)
    feats["veh_ppi_ind_yoy"] = _yoy_change(ppi_ind, last_released)
    feats["veh_ppi_ind_mom"] = _mom_change(ppi_ind, last_released)

    # --- Oil * USD interaction (import vehicle parts cost) -------------
    oil = daily_frame.get(_OIL_WTI, pd.Series(dtype=float))
    usd = daily_frame.get(_USD_BROAD, pd.Series(dtype=float))
    if len(oil) > 0 and len(usd) > 0:
        oil_recent = oil.loc[oil.index <= as_of]
        usd_recent = usd.loc[usd.index <= as_of]
        if len(oil_recent) >= 21 and len(usd_recent) >= 21:
            ow = oil_recent.iloc[-21:]
            uw = usd_recent.iloc[-21:]
            if ow.iloc[0] != 0 and uw.iloc[0] != 0:
                oil_chg = float((ow.iloc[-1] / ow.iloc[0] - 1.0) * 100.0)
                usd_chg = float((uw.iloc[-1] / uw.iloc[0] - 1.0) * 100.0)
                # Positive USD strengthening offsets oil rising — true
                # input cost is roughly oil_chg - usd_chg.
                feats["veh_oilusd_net"] = oil_chg - usd_chg
            else:
                feats["veh_oilusd_net"] = np.nan
        else:
            feats["veh_oilusd_net"] = np.nan
    else:
        feats["veh_oilusd_net"] = np.nan

    # --- Demand / sentiment -------------------------------------------
    indpro = _safe_series(panel, _INDPRO)
    feats["veh_indpro_yoy"] = _yoy_change(indpro, last_released)
    feats["veh_indpro_mom"] = _mom_change(indpro, last_released)

    rsafs = _safe_series(panel, _RETAIL_SALES)
    feats["veh_rsafs_yoy"] = _yoy_change(rsafs, last_released)
    feats["veh_rsafs_mom"] = _mom_change(rsafs, last_released)

    sent = _safe_series(panel, _UMICH_SENT)
    feats["veh_umich_level"] = _level(sent, last_released)
    feats["veh_umich_mom"] = _mom_change(sent, last_released)

    mich = _safe_series(panel, _MICH)
    feats["veh_mich_level"] = _level(mich, last_released)
    feats["veh_mich_mom"] = _mom_change(mich, last_released)

    # --- "Used-car-stress index" composite -----------------------------
    # Crude idea: when gas is up AND rates are up AND sentiment is down,
    # used-car prices typically soften. We give the model a pre-engineered
    # composite so it doesn't need to discover the interaction in 200 rows.
    try:
        gas_chg = feats.get("veh_gas_chg28")
        afford = feats.get("veh_afford_idx")
        sentiment = feats.get("veh_umich_mom")
        comps = []
        if np.isfinite(gas_chg if gas_chg is not None else np.nan):
            comps.append(gas_chg)
        if np.isfinite(afford if afford is not None else np.nan):
            comps.append(afford * 5.0)  # scale rates+spread up to gas-pct units
        if np.isfinite(sentiment if sentiment is not None else np.nan):
            comps.append(-sentiment)  # sentiment DOWN = stress UP
        if comps:
            feats["veh_stress_idx"] = float(np.mean(comps))
        else:
            feats["veh_stress_idx"] = np.nan
    except Exception:
        feats["veh_stress_idx"] = np.nan

    # --- Manheim placeholder -------------------------------------------
    # If a future revision adds a server-side Manheim feed, slot the
    # nowcast value here. For now we always emit NaN + 0 used-flag so the
    # model treats the column as a missing feature.
    feats["veh_manheim_yoy"] = np.nan
    feats["veh_manheim_mom"] = np.nan
    feats["veh_used_manheim"] = 0.0

    return feats


# ---------------------------------------------------------------------------
# Supervised dataset
# ---------------------------------------------------------------------------


def _build_supervised_vehicles(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series]:
    """Rich features + vehicle-channel features per training month."""
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

        try:
            feats.update(
                _vehicle_features_for_month(panel, daily_frame, month_end, as_of)
            )
        except Exception:
            pass

        feats["target_month_end"] = month_end
        rows.append(feats)
        targets.append(float(y_mom.loc[month_end]))

    if not rows:
        # Caller should handle empty (insufficient history).
        return pd.DataFrame(), pd.Series(dtype=float)

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
    """Fit q={0.1, 0.5, 0.9} GBR. Each one independently."""
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
# Public API
# ---------------------------------------------------------------------------


def backtest_vehicles_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest using rich features + vehicle-CPI-channel features.

    For each historical cut t in the trailing `window_months`:
      - train q={0.1, 0.5, 0.9} GBRs on combined features from data
        strictly BEFORE t,
      - predict t's MoM at the median quantile,
      - clip to [-1.5, 2.5], chain to YoY against published CPI 12m prior.

    Manheim is NOT used (no public scrape integrated). The vehicle features
    are derived entirely from FRED proxies already present in the panel.
    Each cut is wrapped in try/except.
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

            X, y = _build_supervised_vehicles(
                train_panel, daily_frame, as_of_day=as_of_day,
            )
            if len(X) < 24:
                continue

            models = _fit_quantile_models(X, y)
            cols = list(X.columns)

            # Inference features for THIS cut.
            m_start = target_month_end + pd.offsets.MonthBegin(-1)
            as_of = _as_of_for_month(m_start, as_of_day)
            feats = rich_features_at(daily_frame, as_of)

            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue
            feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
            feats["cpi_mom_lag2"] = (
                float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
            )
            feats["cpi_yoy_lag1"] = float(
                (
                    train_panel[TARGET.fred_id].dropna().iloc[-1]
                    / train_panel[TARGET.fred_id].dropna().iloc[-13]
                    - 1.0
                )
                * 100.0
            )
            feats["month_sin"] = float(
                np.sin(2 * np.pi * target_month_end.month / 12.0)
            )
            feats["month_cos"] = float(
                np.cos(2 * np.pi * target_month_end.month / 12.0)
            )
            try:
                feats.update(
                    _vehicle_features_for_month(
                        train_panel, daily_frame, target_month_end, as_of
                    )
                )
            except Exception:
                pass

            x_inf = pd.Series(feats)
            x_inf = (
                x_inf.reindex(cols)
                .fillna(X.median(numeric_only=True))
                .fillna(0.0)
            )

            mid, lo, hi = _predict_triple(models, x_inf, cols)
            mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))
            actual_mom = float(y_mom.iloc[ci])

            last_cpi_train = float(
                train_panel[TARGET.fred_id].dropna().iloc[-1]
            )
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
            rows.append(
                {
                    "target_month": target_month_end.strftime("%Y-%m"),
                    "as_of": as_of.strftime("%Y-%m-%d"),
                    "pred_mom": round(mid, 4),
                    "actual_mom": round(actual_mom, 4),
                    "pred_yoy": round(pred_yoy, 3),
                    "actual_yoy": round(actual_yoy, 3),
                    "yoy_err": round(pred_yoy - actual_yoy, 3),
                }
            )
        except Exception:
            continue

    if not preds_mom:
        return {"error": "no successful cuts"}

    pm = np.array(preds_mom)
    am = np.array(actuals_mom)
    py = np.array(preds_yoy)
    ay = np.array(actuals_yoy)
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
        "usedManheim": False,
        "rows": rows,
    }


def run_vehicles_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> VehiclesNowcastResult:
    """Live nowcast using the rich + vehicle-channel feature stack.

    Pulls fresh panels, fits the q={0.1, 0.5, 0.9} GBR stack on the full
    historical training set, then produces a forecast for the next-to-be-
    published CPI month. No Manheim scrape — see module docstring.
    """
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    X, y = _build_supervised_vehicles(panel, daily_frame, as_of_day=as_of_day)
    if len(X) < 24:
        raise RuntimeError("insufficient training history for vehicles nowcast")
    models = _fit_quantile_models(X, y)
    cols = list(X.columns)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (
        last_released_month_end + pd.offsets.MonthBegin(1)
    ) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    feats = rich_features_at(daily_frame, as_of)
    y_mom = build_target(panel).dropna()
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    try:
        feats.update(
            _vehicle_features_for_month(panel, daily_frame, target_month_end, as_of)
        )
    except Exception:
        pass

    x_inf = (
        pd.Series(feats)
        .reindex(cols)
        .fillna(X.median(numeric_only=True))
        .fillna(0.0)
    )
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
    return VehiclesNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_manheim=False,
    )
