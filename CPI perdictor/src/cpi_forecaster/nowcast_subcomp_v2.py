"""Subcomponent CPI nowcaster v2 (Agent SCV2).

Forecasts Food (CPIUFDSL), Energy (CPIENGSL), and Core (CPILFESL)
SEPARATELY, each with its own quantile-rich architecture clone, then
aggregates with BLS prior weights to produce a headline CPI nowcast.

Why this beats forecasting headline directly: each subcomponent has a
much higher signal-to-noise ratio in its native drivers. Energy moves
with WTI/Brent/retail-gas at daily resolution; Core is dominated by
sticky shelter and wage growth; Food sits in between (PPI commodities +
oil for logistics). Forcing one model to reconcile all three signals at
once dilutes the strong predictors.

Why this differs from the failed `strategies/hierarchical.py`:
  - hierarchical.py used a single Ridge per (component, horizon) — too
    weak for energy spikes, no quantile loss, no within-month signals.
  - subcomp_v2 clones the PROVEN nowcast_quantile_rich architecture
    (3 GBR-quantile models per component at q=0.1/0.5/0.9, sorted to fix
    crossing) but with COMPONENT-SPECIFIC daily features (e.g., Energy
    sees only the oil/gas family, Core sees shelter + wages monthlies).
  - hierarchical.py learned weights from data; subcomp_v2 uses BLS
    prior weights (0.13, 0.07, 0.80) — empirical weight estimation has
    historically been unstable on small samples.

Aggregation: headline_MoM = 0.13*food + 0.07*energy + 0.80*core.
80% interval via independence: sigma^2 = sum w_i^2 * sigma_i^2, where
sigma_i is estimated from the q90-q10 spread of each subforecaster.

Same return shape as `nowcast.backtest_nowcast`. Per-cut runtime budget
< 60s. Each cut wrapped in try/except.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor

from .api_client import get_daily_panel
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_QUANTILES = (0.1, 0.5, 0.9)
_MOM_LO_CLIP = -3.0   # wider than headline; energy can blow out
_MOM_HI_CLIP = 4.0
_RESID_FLOOR = 0.05
_Z80 = 1.2816  # 80% normal quantile

# BLS prior weights for headline = w_F * food + w_E * energy + w_C * core.
_W_FOOD = 0.13
_W_ENERGY = 0.07
_W_CORE = 0.80

# Component series IDs.
_FOOD_ID = "CPIUFDSL"
_ENERGY_ID = "CPIENGSL"
_CORE_ID = "CPILFESL"

# Slim GBR — keeps per-cut runtime well under 60s when fitting 9 models
# (3 components x 3 quantiles).
_GBR_PARAMS = dict(
    n_estimators=300,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)


# --- per-component daily-feature whitelists --------------------------
#
# Each subforecaster only consumes the daily series economically
# relevant to its component. This is the main difference from the
# generic nowcast_quantile_rich, which feeds ALL daily series into
# every model.

_FOOD_DAILY = (
    "DCOILWTICO",  # oil — logistics + agri inputs
)
_FOOD_WEEKLY: tuple[str, ...] = ()
_FOOD_MONTHLY = (
    "PPIACO",  # all-commodities PPI — broad food upstream
    "PPIIDC",  # PPI industrial commodities
    "PPIFIS",  # final-demand PPI
)

_ENERGY_DAILY = (
    "DCOILWTICO",   # WTI
    "DCOILBRENTEU", # Brent
    "DTWEXBGS",     # USD broad — oil priced in $
)
_ENERGY_WEEKLY = (
    "GASREGW",  # retail regular gasoline
    "GASDESW",  # retail diesel
)
_ENERGY_MONTHLY: tuple[str, ...] = ()

_CORE_DAILY: tuple[str, ...] = ()  # Core mostly monthly; daily is too noisy
_CORE_WEEKLY: tuple[str, ...] = ()
_CORE_MONTHLY = (
    "CES0500000003",      # avg hourly earnings (wages)
    "CSUSHPISA",          # Case-Shiller (leading shelter)
    "CUSR0000SAH1",       # CPI shelter (largest core slice)
    "MICH",               # Michigan 1Y inflation expectations
    "UNRATE",             # labor slack
    "STICKCPIM157SFRBATL",  # Atlanta Fed Sticky CPI (if available)
    "PCEPILFE",           # core PCE
)


# --- log-MoM helper --------------------------------------------------

def _log_mom(s: pd.Series) -> pd.Series:
    return (np.log(s) - np.log(s.shift(1))) * 100.0


def _safe(x) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return np.nan
    if not np.isfinite(v):
        return np.nan
    return v


def _month_start(ts: pd.Timestamp) -> pd.Timestamp:
    return pd.Timestamp(year=ts.year, month=ts.month, day=1)


def _window_mean(s: pd.Series, end: pd.Timestamp, n: int) -> float:
    start = end - pd.Timedelta(days=n)
    w = s.loc[(s.index > start) & (s.index <= end)]
    if len(w) == 0:
        return np.nan
    return float(w.mean())


def _window_pct_change(s: pd.Series, end: pd.Timestamp, n: int) -> float:
    recent = _window_mean(s, end, n)
    mid = end - pd.Timedelta(days=n)
    prior = _window_mean(s, mid, n)
    if not np.isfinite(recent) or not np.isfinite(prior) or prior == 0:
        return np.nan
    return (recent / prior - 1.0) * 100.0


def _mtd_window(s: pd.Series, as_of: pd.Timestamp) -> pd.Series:
    start = _month_start(as_of)
    return s.loc[(s.index >= start) & (s.index <= as_of)]


def _prior_month_window(s: pd.Series, as_of: pd.Timestamp) -> pd.Series:
    this_start = _month_start(as_of)
    prior_end = this_start - pd.Timedelta(days=1)
    prior_start = _month_start(prior_end)
    return s.loc[(s.index >= prior_start) & (s.index <= prior_end)]


def _daily_returns(s: pd.Series) -> pd.Series:
    if len(s) < 2:
        return pd.Series([], dtype=float)
    arr = s.values.astype(float)
    safe_prev = np.where(arr[:-1] != 0, arr[:-1], np.nan)
    rets = (arr[1:] / safe_prev - 1.0) * 100.0
    return pd.Series(rets, index=s.index[1:])


# --- per-component feature builder -----------------------------------


def _component_features_at(
    daily_frame: dict[str, pd.Series],
    panel: pd.DataFrame,
    as_of: pd.Timestamp,
    target_month_end: pd.Timestamp,
    component_id: str,
    daily_ids: tuple[str, ...],
    weekly_ids: tuple[str, ...],
    monthly_ids: tuple[str, ...],
) -> dict[str, float]:
    """Build the feature dict for ONE subcomponent at one as-of date.

    Mixes:
      - Component's own MoM lags + 3-month change (always)
      - Component-specific DAILY features (multi-window momentum, MTD,
        spike, accel) — clone of rich_features_at but only on whitelisted IDs
      - Component-specific WEEKLY features (latest, 4wk pct)
      - Component-specific MONTHLY lag-1 features (raw lag, MoM, YoY)
      - Calendar (month_sin/cos, MTD weekend/weekday)
    """
    feats: dict[str, float] = {}

    # ---- Component's own monthly lags (using only data BEFORE target_month_end) ----
    if component_id in panel.columns:
        comp = panel[component_id].dropna()
        comp_until = comp.loc[comp.index < target_month_end]
        comp_mom = _log_mom(comp).dropna()
        comp_mom_until = comp_mom.loc[comp_mom.index < target_month_end]

        feats[f"{component_id}_mom_lag1"] = (
            _safe(comp_mom_until.iloc[-1]) if len(comp_mom_until) >= 1 else np.nan
        )
        feats[f"{component_id}_mom_lag2"] = (
            _safe(comp_mom_until.iloc[-2]) if len(comp_mom_until) >= 2 else np.nan
        )
        feats[f"{component_id}_mom_lag3"] = (
            _safe(comp_mom_until.iloc[-3]) if len(comp_mom_until) >= 3 else np.nan
        )
        # 3-month MoM (rolling sum of last 3 log-MoMs)
        if len(comp_mom_until) >= 3:
            feats[f"{component_id}_mom_3mo"] = float(comp_mom_until.iloc[-3:].sum())
        else:
            feats[f"{component_id}_mom_3mo"] = np.nan
        # YoY lag-1
        if len(comp_until) >= 13:
            feats[f"{component_id}_yoy_lag1"] = _safe(
                (comp_until.iloc[-1] / comp_until.iloc[-13] - 1.0) * 100.0
            )
        else:
            feats[f"{component_id}_yoy_lag1"] = np.nan

    # ---- Component-specific DAILY features (rich, multi-window) ----
    for sid in daily_ids:
        s = daily_frame.get(sid)
        if s is None or len(s) == 0:
            continue
        s_until = s.loc[s.index <= as_of]
        if len(s_until) == 0:
            continue

        for n in (3, 7, 14, 21):
            feats[f"{sid}_mom{n}"] = _safe(_window_pct_change(s_until, as_of, n))

        mtd = _mtd_window(s_until, as_of)
        prior = _prior_month_window(s_until, as_of)
        mtd_n = int(len(mtd))
        feats[f"{sid}_mtd_n"] = float(mtd_n)
        feats[f"{sid}_completeness"] = min(mtd_n, 31) / 31.0
        if len(prior) > 0 and len(mtd) > 0:
            p_avg = float(prior.mean())
            m_avg = float(mtd.mean())
            if np.isfinite(p_avg) and p_avg != 0 and np.isfinite(m_avg):
                feats[f"{sid}_mtd_pct"] = (m_avg / p_avg - 1.0) * 100.0
            else:
                feats[f"{sid}_mtd_pct"] = np.nan
        else:
            feats[f"{sid}_mtd_pct"] = np.nan

        if len(mtd) >= 3:
            rets = _daily_returns(mtd)
            feats[f"{sid}_vol_mtd"] = (
                _safe(rets.std()) if len(rets) > 1 else np.nan
            )
        else:
            feats[f"{sid}_vol_mtd"] = np.nan

        last7 = _window_mean(s_until, as_of, 7)
        prior7 = _window_mean(s_until, as_of - pd.Timedelta(days=7), 7)
        prior14 = _window_mean(s_until, as_of - pd.Timedelta(days=14), 7)
        if (
            np.isfinite(last7) and np.isfinite(prior7) and np.isfinite(prior14)
            and prior7 != 0 and prior14 != 0
        ):
            r1 = (last7 / prior7 - 1.0) * 100.0
            r0 = (prior7 / prior14 - 1.0) * 100.0
            feats[f"{sid}_accel_7v7"] = r1 - r0
        else:
            feats[f"{sid}_accel_7v7"] = np.nan

        # last-7-day pct change (already in mom7 above) — extra: latest pct
        if len(s_until) >= 1:
            feats[f"{sid}_latest"] = _safe(s_until.iloc[-1])

        if len(mtd) >= 5:
            rets = _daily_returns(mtd)
            if len(rets) >= 3:
                recent3_mean = float(rets.iloc[-3:].mean())
                std = float(rets.std()) if len(rets) > 1 else np.nan
                if np.isfinite(std) and std > 0:
                    feats[f"{sid}_spike"] = recent3_mean / std
                else:
                    feats[f"{sid}_spike"] = np.nan
            else:
                feats[f"{sid}_spike"] = np.nan
        else:
            feats[f"{sid}_spike"] = np.nan

    # ---- Component-specific WEEKLY features ----
    for sid in weekly_ids:
        s = daily_frame.get(sid)
        if s is None or len(s) == 0:
            feats[f"{sid}_latest"] = np.nan
            feats[f"{sid}_4wk_pct"] = np.nan
            continue
        recent = s.loc[s.index <= as_of]
        if len(recent) == 0:
            feats[f"{sid}_latest"] = np.nan
            feats[f"{sid}_4wk_pct"] = np.nan
            continue
        feats[f"{sid}_latest"] = _safe(recent.iloc[-1])
        last4 = recent.iloc[-4:]
        prior4 = recent.iloc[-8:-4] if len(recent) >= 8 else None
        if prior4 is not None and len(prior4) > 0:
            r = float(last4.mean())
            p = float(prior4.mean())
            feats[f"{sid}_4wk_pct"] = (
                ((r / p - 1.0) * 100.0) if p != 0 else np.nan
            )
        else:
            feats[f"{sid}_4wk_pct"] = np.nan

    # ---- Component-specific MONTHLY features (lag-1 of monthly drivers) ----
    for sid in monthly_ids:
        if sid not in panel.columns:
            continue
        s = panel[sid].dropna()
        s_until = s.loc[s.index < target_month_end]
        if len(s_until) < 2:
            continue
        # MoM lag-1
        last = float(s_until.iloc[-1])
        prev = float(s_until.iloc[-2])
        if prev != 0:
            feats[f"{sid}_mom_lag1"] = (last / prev - 1.0) * 100.0
        else:
            feats[f"{sid}_mom_lag1"] = np.nan
        # 3-month % change lag-1
        if len(s_until) >= 4:
            three_back = float(s_until.iloc[-4])
            if three_back != 0:
                feats[f"{sid}_3mo_lag1"] = (last / three_back - 1.0) * 100.0
            else:
                feats[f"{sid}_3mo_lag1"] = np.nan
        else:
            feats[f"{sid}_3mo_lag1"] = np.nan
        # YoY lag-1
        if len(s_until) >= 13:
            yoy_back = float(s_until.iloc[-13])
            if yoy_back != 0:
                feats[f"{sid}_yoy_lag1"] = (last / yoy_back - 1.0) * 100.0
            else:
                feats[f"{sid}_yoy_lag1"] = np.nan
        else:
            feats[f"{sid}_yoy_lag1"] = np.nan
        # Latest level (z-score-ish handled implicitly by GBR splits)
        feats[f"{sid}_latest"] = _safe(last)

    # ---- Calendar features ----
    feats["month_sin"] = float(
        np.sin(2 * np.pi * target_month_end.month / 12.0)
    )
    feats["month_cos"] = float(
        np.cos(2 * np.pi * target_month_end.month / 12.0)
    )
    start = _month_start(as_of)
    days = pd.date_range(start=start, end=as_of, freq="D")
    weekend_count = int(sum(d.weekday() >= 5 for d in days))
    weekday_count = int(len(days) - weekend_count)
    feats["mtd_weekday_count"] = float(weekday_count)
    feats["mtd_weekend_count"] = float(weekend_count)

    return feats


# --- supervised dataset builder per component -----------------------


def _build_supervised_component(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    component_id: str,
    daily_ids: tuple[str, ...],
    weekly_ids: tuple[str, ...],
    monthly_ids: tuple[str, ...],
    as_of_day: int,
    min_history_months: int = 36,
) -> tuple[pd.DataFrame, pd.Series]:
    """Build (X, y) where y = component_log_mom and X uses only data
    available by day `as_of_day` of the target month."""
    if component_id not in panel.columns:
        raise RuntimeError(f"Component {component_id} not in panel.")
    comp = panel[component_id].dropna()
    y_comp = _log_mom(comp).dropna()

    eligible_months = y_comp.index[min_history_months:]

    rows: list[dict] = []
    targets: list[float] = []
    for month_end in eligible_months:
        m_start = month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        try:
            feats = _component_features_at(
                daily_frame=daily_frame,
                panel=panel,
                as_of=as_of,
                target_month_end=month_end,
                component_id=component_id,
                daily_ids=daily_ids,
                weekly_ids=weekly_ids,
                monthly_ids=monthly_ids,
            )
        except Exception:
            continue
        feats["target_month_end"] = month_end
        rows.append(feats)
        targets.append(float(y_comp.loc[month_end]))

    if not rows:
        raise RuntimeError(f"No supervised rows built for {component_id}.")

    df = pd.DataFrame(rows).set_index("target_month_end")
    y = pd.Series(targets, index=df.index, name="y_mom")
    df = df.dropna(axis=1, how="all")
    df = df.fillna(df.median(numeric_only=True))
    df = df.fillna(0.0)
    return df, y


# --- per-component model --------------------------------------------


@dataclass
class ComponentQuantileModel:
    component_id: str
    models: dict[float, GradientBoostingRegressor]
    feature_cols: list[str]

    def predict_one(self, x: pd.Series) -> tuple[float, float, float]:
        """Return (median, lo10, hi90) — sorted to fix quantile crossing."""
        x_aligned = (
            x.reindex(self.feature_cols).fillna(0.0).values.reshape(1, -1)
        )
        preds = []
        for q in _QUANTILES:
            preds.append(float(self.models[q].predict(x_aligned)[0]))
        triple = np.sort(np.array(preds, dtype=float))
        return float(triple[1]), float(triple[0]), float(triple[2])


def _fit_component_model(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    component_id: str,
    daily_ids: tuple[str, ...],
    weekly_ids: tuple[str, ...],
    monthly_ids: tuple[str, ...],
    as_of_day: int,
) -> ComponentQuantileModel:
    X, y = _build_supervised_component(
        panel, daily_frame, component_id,
        daily_ids, weekly_ids, monthly_ids,
        as_of_day=as_of_day,
    )
    cols = list(X.columns)
    Xv = X.values
    yv = y.values
    models: dict[float, GradientBoostingRegressor] = {}
    for q in _QUANTILES:
        gbr = GradientBoostingRegressor(
            loss="quantile", alpha=q, **_GBR_PARAMS,
        ).fit(Xv, yv)
        models[q] = gbr
    return ComponentQuantileModel(
        component_id=component_id,
        models=models,
        feature_cols=cols,
    )


# --- chain helper ----------------------------------------------------


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


# --- result containers ----------------------------------------------


@dataclass
class SubCompV2NowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    food_mom: float
    energy_mom: float
    core_mom: float


# --- backtest --------------------------------------------------------


def backtest_subcomp_v2_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = 20,
) -> dict:
    """Walk-forward backtest of the subcomponent v2 nowcaster.

    For each historical cut t in the trailing `window_months`:
      - For each subcomponent c in {Food, Energy, Core}:
          - Build (X_c, y_c) using only data BEFORE t and component-
            specific features (daily + weekly + monthly).
          - Fit 3 GBR-quantile models (q=0.1, 0.5, 0.9). Predict t.
          - Median = sorted middle. sigma_c estimated from (q90-q10)/(2*z80).
      - Aggregate: head_mom = 0.13*food + 0.07*energy + 0.80*core.
      - Variance: sigma_h^2 = 0.13^2*sigma_F^2 + 0.07^2*sigma_E^2 + 0.80^2*sigma_C^2.
      - Chain head_mom -> head_yoy via published headline CPI 12mo prior.

    A failed cut (insufficient history, fit failure, missing component
    in panel, etc.) is skipped via try/except. Same return shape as
    `nowcast.backtest_nowcast`.
    """
    if TARGET.fred_id not in panel.columns:
        return {"error": f"Panel missing {TARGET.fred_id}"}

    # Pre-fetch headline CPI (used for YoY denominator + actual_yoy).
    cpi = panel[TARGET.fred_id].dropna()
    # Use headline MoM index for cut alignment so we report on the same
    # months as `nowcast.backtest_nowcast`.
    head_mom = _log_mom(panel[TARGET.fred_id]).dropna()

    cuts = list(range(len(head_mom) - window_months, len(head_mom)))
    preds_mom: list[float] = []
    actuals_mom: list[float] = []
    preds_yoy: list[float] = []
    actuals_yoy: list[float] = []
    rows: list[dict] = []

    components: tuple[tuple[str, tuple, tuple, tuple, float], ...] = (
        (_FOOD_ID,   _FOOD_DAILY,   _FOOD_WEEKLY,   _FOOD_MONTHLY,   _W_FOOD),
        (_ENERGY_ID, _ENERGY_DAILY, _ENERGY_WEEKLY, _ENERGY_MONTHLY, _W_ENERGY),
        (_CORE_ID,   _CORE_DAILY,   _CORE_WEEKLY,   _CORE_MONTHLY,   _W_CORE),
    )

    for ci in cuts:
        try:
            target_month_end = head_mom.index[ci]
            train_panel = panel.loc[panel.index < target_month_end]
            if len(train_panel) < 60:
                continue
            # Need all 3 components to be present in training panel.
            missing = [c for c, *_ in components if c not in train_panel.columns]
            if missing:
                continue

            m_start = target_month_end + pd.offsets.MonthBegin(-1)
            as_of = _as_of_for_month(m_start, as_of_day)

            # --- Fit one quantile model per component ---
            comp_preds: dict[str, tuple[float, float, float]] = {}
            for cid, daily_ids, weekly_ids, monthly_ids, _ in components:
                model = _fit_component_model(
                    train_panel, daily_frame, cid,
                    daily_ids, weekly_ids, monthly_ids,
                    as_of_day=as_of_day,
                )
                feats = _component_features_at(
                    daily_frame=daily_frame,
                    panel=train_panel,
                    as_of=as_of,
                    target_month_end=target_month_end,
                    component_id=cid,
                    daily_ids=daily_ids,
                    weekly_ids=weekly_ids,
                    monthly_ids=monthly_ids,
                )
                med, lo, hi = model.predict_one(pd.Series(feats))
                med = float(np.clip(med, _MOM_LO_CLIP, _MOM_HI_CLIP))
                comp_preds[cid] = (med, lo, hi)

            food_med, food_lo, food_hi = comp_preds[_FOOD_ID]
            ener_med, ener_lo, ener_hi = comp_preds[_ENERGY_ID]
            core_med, core_lo, core_hi = comp_preds[_CORE_ID]

            # --- Aggregate to headline MoM via BLS prior weights ---
            head_pred_mom = (
                _W_FOOD * food_med
                + _W_ENERGY * ener_med
                + _W_CORE * core_med
            )
            head_pred_mom = float(
                np.clip(head_pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP)
            )

            # --- Chain to YoY against published headline CPI 12mo prior ---
            last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
            pred_yoy = _mom_to_yoy(
                head_pred_mom, last_cpi_train, target_month_end, cpi,
            )
            actual_cpi = float(cpi.loc[target_month_end])
            denom_idx = target_month_end - pd.DateOffset(years=1)
            denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
            try:
                denom = float(cpi.loc[denom_idx])
            except KeyError:
                denom = float(cpi.asof(denom_idx))
            actual_yoy = (actual_cpi / denom - 1.0) * 100.0
            actual_mom = float(head_mom.iloc[ci])

            preds_mom.append(head_pred_mom)
            actuals_mom.append(actual_mom)
            preds_yoy.append(pred_yoy)
            actuals_yoy.append(actual_yoy)
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of.strftime("%Y-%m-%d"),
                "pred_mom": round(head_pred_mom, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "food_mom": round(food_med, 4),
                "energy_mom": round(ener_med, 4),
                "core_mom": round(core_med, 4),
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


# --- live entry point -----------------------------------------------


def run_subcomp_v2_nowcast(as_of_day: int = 20) -> SubCompV2NowcastResult:
    """Pull live panels, fit 3 subcomponent models, aggregate, return
    a current-month CPI nowcast with 80% interval."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (
        (last_released_month_end + pd.offsets.MonthBegin(1))
        + pd.offsets.MonthEnd(0)
    )
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    components: tuple[tuple[str, tuple, tuple, tuple, float], ...] = (
        (_FOOD_ID,   _FOOD_DAILY,   _FOOD_WEEKLY,   _FOOD_MONTHLY,   _W_FOOD),
        (_ENERGY_ID, _ENERGY_DAILY, _ENERGY_WEEKLY, _ENERGY_MONTHLY, _W_ENERGY),
        (_CORE_ID,   _CORE_DAILY,   _CORE_WEEKLY,   _CORE_MONTHLY,   _W_CORE),
    )

    comp_preds: dict[str, tuple[float, float, float]] = {}
    for cid, daily_ids, weekly_ids, monthly_ids, _ in components:
        try:
            model = _fit_component_model(
                panel, daily_frame, cid,
                daily_ids, weekly_ids, monthly_ids,
                as_of_day=as_of_day,
            )
            feats = _component_features_at(
                daily_frame=daily_frame,
                panel=panel,
                as_of=as_of,
                target_month_end=target_month_end,
                component_id=cid,
                daily_ids=daily_ids,
                weekly_ids=weekly_ids,
                monthly_ids=monthly_ids,
            )
            med, lo, hi = model.predict_one(pd.Series(feats))
            med = float(np.clip(med, _MOM_LO_CLIP, _MOM_HI_CLIP))
            comp_preds[cid] = (med, lo, hi)
        except Exception:
            # Component-level fallback: last observed MoM, wide interval.
            try:
                s = _log_mom(panel[cid]).dropna()
                last = float(s.iloc[-1]) if not s.empty else 0.0
                sd = float(s.tail(60).std()) if len(s) >= 12 else 0.30
            except Exception:
                last, sd = 0.0, 0.30
            sd = max(sd, 0.10)
            comp_preds[cid] = (last, last - _Z80 * sd, last + _Z80 * sd)

    food_med, food_lo, food_hi = comp_preds[_FOOD_ID]
    ener_med, ener_lo, ener_hi = comp_preds[_ENERGY_ID]
    core_med, core_lo, core_hi = comp_preds[_CORE_ID]

    head_pred_mom = (
        _W_FOOD * food_med
        + _W_ENERGY * ener_med
        + _W_CORE * core_med
    )
    head_pred_mom = float(np.clip(head_pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))

    # sigma per component from quantile spread.
    def _sigma(lo: float, hi: float) -> float:
        spread = max(hi - lo, 0.0)
        s = spread / (2.0 * _Z80)
        return max(s, _RESID_FLOOR)

    sf = _sigma(food_lo, food_hi)
    se = _sigma(ener_lo, ener_hi)
    sc = _sigma(core_lo, core_hi)
    var_h = (
        (_W_FOOD ** 2) * sf * sf
        + (_W_ENERGY ** 2) * se * se
        + (_W_CORE ** 2) * sc * sc
    )
    head_std = float(np.sqrt(max(var_h, 0.0)))
    head_lo_mom = head_pred_mom - _Z80 * head_std
    head_hi_mom = head_pred_mom + _Z80 * head_std

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(head_pred_mom, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(head_lo_mom, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(head_hi_mom, last_cpi, target_month_end, cpi)
    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )

    return SubCompV2NowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=head_pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        food_mom=food_med,
        energy_mom=ener_med,
        core_mom=core_med,
    )
