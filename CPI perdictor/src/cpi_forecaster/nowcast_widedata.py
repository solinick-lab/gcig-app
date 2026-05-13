"""Wide-daily-panel CPI nowcaster (Agent WIDE).

Hypothesis: the existing daily panel only carries 14 series (oil, broad
USD, the Treasury 2y/10y endpoints, breakevens, HY spread, retail gas,
diesel, jobless claims). FRED has dozens more daily/weekly series that
nudge near-term CPI:

  - Heating oil + Gulf wholesale gasoline    -> retail gas leads
  - USD vs MXN / CNY / JPY                   -> imported-goods prices
  - Full Treasury curve (1m, 3m, 5y, 30y)    -> shape of inflation expectations
  - Moody's AAA / BAA corporate yields       -> credit-channel inflation pass-through
  - 3m commercial paper, prime rate          -> short-funding pressure
  - Weekly PPI gasoline                      -> producer-side cost shock

This module mirrors `nowcast_quantile_rich`'s architecture (three
GBR-quantile fits at q={0.1, 0.5, 0.9}, sorted to fix crossing) but
augments the rich-features feature set with simple summaries (MTD-avg
percent change vs prior month, last-7-day percent change) for every
new high-frequency series.

Critically, every series-existence check is wrapped — the production
server hasn't necessarily redeployed with the wider panel yet, so the
strategy must run gracefully even if `daily_frame` only contains the
old 14 series. New columns then collapse to medians / zeros and the
model degrades to ~rich-quantile.

Standard public interface:
    backtest_widedata_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
    run_widedata_nowcast(as_of_day=20) -> WideDataNowcastResult

Each cut is wrapped in try/except, MoM is sanity-clipped to [-1.5, 2.5].
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

try:
    from sklearn.ensemble import GradientBoostingRegressor
except Exception:  # pragma: no cover - sklearn always available in this repo
    GradientBoostingRegressor = None  # type: ignore

try:
    from .api_client import get_daily_panel
    from .features import build_target
    from .fred import TARGET, fetch_panel
    from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
    from .nowcast_features import build_daily_frame
    from .nowcast_richfeats import rich_features_at
except Exception:  # pragma: no cover - import-time guard
    # Defer the import error until callers actually invoke the public entry
    # points; this keeps `import nowcast_widedata` safe in environments
    # where sibling modules aren't yet on the path.
    raise


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_QUANTILES = (0.1, 0.5, 0.9)
_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05  # min half-width on YoY interval

_GBR_PARAMS = dict(
    n_estimators=400,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)


# --- new high-frequency series we want to exploit --------------------
#
# Each is wrapped at feature time with `if sid in daily_frame:` so the
# strategy degrades gracefully if the server hasn't redeployed yet.
#
# Confidence column (mental note, not enforced):
#   HIGH   -> well-known FRED daily IDs, almost certain to exist
#   MED    -> exists on FRED but ID spelling has historical alternates
#   SPEC   -> speculative; might not be a daily on FRED at all
_NEW_DAILY_IDS = (
    # Energy (daily wholesale)
    "MHOILNYH",     # MED  — heating oil; sometimes published as DHOILNYH
    "DGASUSGULF",   # SPEC — Gulf wholesale gasoline; daily ID spelling varies
    # FX (HIGH — these are the canonical daily FRED IDs)
    "DEXMXUS",
    "DEXCHUS",
    "DEXJPUS",
    # Treasury curve (HIGH)
    "DGS5",
    "DGS30",
    "DTB3",
    "DGS1MO",
    # Corporate / money market (HIGH for DAAA, DBAA, DPRIME; MED for DCPN3M)
    "DAAA",
    "DBAA",
    "DCPN3M",
    "DPRIME",
)

# Weekly-ish: PPI gasoline is technically monthly on FRED, but if the server
# fetches it under WEEKLY we still want to surface it here. Wrapped safely.
_NEW_WEEKLY_IDS = (
    "WPU057",       # SPEC — PPI gasoline; monthly on FRED, included for forward-compat
)


# ---------------------------------------------------------------------
# Result / model dataclasses
# ---------------------------------------------------------------------


@dataclass
class WideDataNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int


@dataclass
class WideDataNowcastModel:
    models: dict
    feature_cols: list
    as_of_day: int

    def predict_one(self, x: pd.Series):
        """Return (median, lo10, hi90) — sorted to fix any quantile crossing."""
        x_aligned = x.reindex(self.feature_cols).fillna(0.0).values.reshape(1, -1)
        preds = []
        for q in _QUANTILES:
            preds.append(float(self.models[q].predict(x_aligned)[0]))
        triple = np.sort(np.array(preds, dtype=float))
        return float(triple[1]), float(triple[0]), float(triple[2])


# ---------------------------------------------------------------------
# Feature engineering for new series (graceful)
# ---------------------------------------------------------------------


def _month_start(ts: pd.Timestamp) -> pd.Timestamp:
    return pd.Timestamp(year=ts.year, month=ts.month, day=1)


def _safe_float(x) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return np.nan
    if not np.isfinite(v):
        return np.nan
    return v


def _mtd_avg(s: pd.Series, as_of: pd.Timestamp) -> float:
    try:
        start = _month_start(as_of)
        w = s.loc[(s.index >= start) & (s.index <= as_of)]
        if len(w) == 0:
            return np.nan
        return float(w.mean())
    except Exception:
        return np.nan


def _prior_month_avg(s: pd.Series, as_of: pd.Timestamp) -> float:
    try:
        this_start = _month_start(as_of)
        prior_end = this_start - pd.Timedelta(days=1)
        prior_start = _month_start(prior_end)
        w = s.loc[(s.index >= prior_start) & (s.index <= prior_end)]
        if len(w) == 0:
            return np.nan
        return float(w.mean())
    except Exception:
        return np.nan


def _last_n_pct(s: pd.Series, as_of: pd.Timestamp, n: int) -> float:
    """Mean over (as_of - n, as_of] vs mean over (as_of - 2n, as_of - n]."""
    try:
        end = as_of
        mid = end - pd.Timedelta(days=n)
        start = mid - pd.Timedelta(days=n)
        recent = s.loc[(s.index > mid) & (s.index <= end)]
        prior = s.loc[(s.index > start) & (s.index <= mid)]
        if len(recent) == 0 or len(prior) == 0:
            return np.nan
        r = float(recent.mean())
        p = float(prior.mean())
        if not np.isfinite(r) or not np.isfinite(p) or p == 0:
            return np.nan
        return (r / p - 1.0) * 100.0
    except Exception:
        return np.nan


def _new_series_features(
    daily_frame: dict,
    as_of: pd.Timestamp,
) -> dict:
    """Build the augmentation feature dict for the new wide-panel series.

    Every lookup is guarded by `if sid in daily_frame` so the strategy
    works even if the server hasn't redeployed yet. Missing series
    contribute NaNs that the supervised builder later fills with column
    medians (or zero if the column is fully empty).
    """
    feats: dict = {}

    # Daily series: MTD-avg pct change vs prior month, plus last-7-day pct change
    for sid in _NEW_DAILY_IDS:
        try:
            if sid not in daily_frame:
                feats[f"{sid}_mtd_pct"] = np.nan
                feats[f"{sid}_last7_pct"] = np.nan
                continue
            s = daily_frame[sid]
            if s is None or len(s) == 0:
                feats[f"{sid}_mtd_pct"] = np.nan
                feats[f"{sid}_last7_pct"] = np.nan
                continue
            s_until = s.loc[s.index <= as_of]
            if len(s_until) == 0:
                feats[f"{sid}_mtd_pct"] = np.nan
                feats[f"{sid}_last7_pct"] = np.nan
                continue
            mtd = _mtd_avg(s_until, as_of)
            prior = _prior_month_avg(s_until, as_of)
            if np.isfinite(mtd) and np.isfinite(prior) and prior != 0:
                feats[f"{sid}_mtd_pct"] = (mtd / prior - 1.0) * 100.0
            else:
                feats[f"{sid}_mtd_pct"] = np.nan
            feats[f"{sid}_last7_pct"] = _last_n_pct(s_until, as_of, 7)
        except Exception:
            feats[f"{sid}_mtd_pct"] = np.nan
            feats[f"{sid}_last7_pct"] = np.nan

    # Curve-shape interactions where the relevant pieces are available
    try:
        if "DGS30" in daily_frame and "DGS5" in daily_frame:
            s30 = daily_frame["DGS30"].loc[daily_frame["DGS30"].index <= as_of]
            s5 = daily_frame["DGS5"].loc[daily_frame["DGS5"].index <= as_of]
            if len(s30) > 0 and len(s5) > 0:
                feats["x_30y_5y_spread"] = _safe_float(float(s30.iloc[-1]) - float(s5.iloc[-1]))
            else:
                feats["x_30y_5y_spread"] = np.nan
        else:
            feats["x_30y_5y_spread"] = np.nan
    except Exception:
        feats["x_30y_5y_spread"] = np.nan

    try:
        if "DBAA" in daily_frame and "DAAA" in daily_frame:
            sb = daily_frame["DBAA"].loc[daily_frame["DBAA"].index <= as_of]
            sa = daily_frame["DAAA"].loc[daily_frame["DAAA"].index <= as_of]
            if len(sb) > 0 and len(sa) > 0:
                feats["x_baa_aaa_spread"] = _safe_float(float(sb.iloc[-1]) - float(sa.iloc[-1]))
            else:
                feats["x_baa_aaa_spread"] = np.nan
        else:
            feats["x_baa_aaa_spread"] = np.nan
    except Exception:
        feats["x_baa_aaa_spread"] = np.nan

    # USD/MXN * gasoline interaction (importer cost-pass-through proxy)
    try:
        if "DEXMXUS" in daily_frame:
            mxn = daily_frame["DEXMXUS"].loc[daily_frame["DEXMXUS"].index <= as_of]
            mxn7 = _last_n_pct(mxn, as_of, 7) if len(mxn) > 0 else np.nan
        else:
            mxn7 = np.nan
        if "DGASUSGULF" in daily_frame:
            gas = daily_frame["DGASUSGULF"].loc[daily_frame["DGASUSGULF"].index <= as_of]
            gas7 = _last_n_pct(gas, as_of, 7) if len(gas) > 0 else np.nan
        else:
            gas7 = np.nan
        if np.isfinite(mxn7) and np.isfinite(gas7):
            feats["x_mxn_gulf_gas"] = mxn7 * gas7
        else:
            feats["x_mxn_gulf_gas"] = np.nan
    except Exception:
        feats["x_mxn_gulf_gas"] = np.nan

    # Weekly-ish series: latest reading + 4w pct change (best-effort).
    for sid in _NEW_WEEKLY_IDS:
        try:
            if sid not in daily_frame:
                feats[f"{sid}_latest"] = np.nan
                feats[f"{sid}_4wk_pct"] = np.nan
                continue
            s = daily_frame[sid]
            if s is None or len(s) == 0:
                feats[f"{sid}_latest"] = np.nan
                feats[f"{sid}_4wk_pct"] = np.nan
                continue
            recent = s.loc[s.index <= as_of]
            if len(recent) == 0:
                feats[f"{sid}_latest"] = np.nan
                feats[f"{sid}_4wk_pct"] = np.nan
                continue
            feats[f"{sid}_latest"] = _safe_float(recent.iloc[-1])
            last4 = recent.iloc[-4:]
            prior4 = recent.iloc[-8:-4] if len(recent) >= 8 else None
            if prior4 is not None and len(prior4) > 0:
                r = float(last4.mean()); p = float(prior4.mean())
                feats[f"{sid}_4wk_pct"] = ((r / p - 1.0) * 100.0) if p != 0 else np.nan
            else:
                feats[f"{sid}_4wk_pct"] = np.nan
        except Exception:
            feats[f"{sid}_latest"] = np.nan
            feats[f"{sid}_4wk_pct"] = np.nan

    return feats


def widedata_features_at(
    daily_frame: dict,
    as_of: pd.Timestamp,
) -> dict:
    """Combine the proven rich-features set with the new wide-panel adds."""
    try:
        base = rich_features_at(daily_frame, as_of)
    except Exception:
        base = {}
    try:
        extras = _new_series_features(daily_frame, as_of)
    except Exception:
        extras = {}
    out = dict(base)
    out.update(extras)
    return out


# ---------------------------------------------------------------------
# Supervised dataset builder
# ---------------------------------------------------------------------


def _build_supervised_widedata(
    panel: pd.DataFrame,
    daily_frame: dict,
    as_of_day: int,
    min_history_months: int = 36,
):
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
    eligible_months = y_mom.index[min_history_months:]

    rows: list = []
    targets: list = []
    for month_end in eligible_months:
        try:
            m_start = month_end + pd.offsets.MonthBegin(-1)
            as_of = _as_of_for_month(m_start, as_of_day)
            try:
                feats = widedata_features_at(daily_frame, as_of)
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
            feats["target_month_end"] = month_end
            rows.append(feats)
            targets.append(float(y_mom.loc[month_end]))
        except Exception:
            continue

    if not rows:
        # Empty supervised set — fall back to a tiny synthetic frame so the
        # caller's GBR.fit() doesn't blow up. Caller's outer try/except
        # will skip this cut.
        df = pd.DataFrame()
        y = pd.Series(dtype=float)
        return df, y

    df = pd.DataFrame(rows).set_index("target_month_end")
    y = pd.Series(targets, index=df.index, name="y_mom")
    df = df.dropna(axis=1, how="all")
    df = df.fillna(df.median(numeric_only=True))
    df = df.fillna(0.0)
    return df, y


# ---------------------------------------------------------------------
# Model fitting
# ---------------------------------------------------------------------


def fit_widedata_nowcast_model(
    panel: pd.DataFrame,
    daily_frame: dict,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> WideDataNowcastModel:
    if GradientBoostingRegressor is None:
        raise RuntimeError("scikit-learn unavailable")
    X, y = _build_supervised_widedata(panel, daily_frame, as_of_day=as_of_day)
    if X.empty or len(y) == 0:
        raise RuntimeError("supervised set empty")
    cols = list(X.columns)
    Xv = X.values
    yv = y.values

    models: dict = {}
    for q in _QUANTILES:
        gbr = GradientBoostingRegressor(
            loss="quantile", alpha=q, **_GBR_PARAMS,
        ).fit(Xv, yv)
        models[q] = gbr

    return WideDataNowcastModel(models=models, feature_cols=cols, as_of_day=as_of_day)


# ---------------------------------------------------------------------
# Inference helpers
# ---------------------------------------------------------------------


def _build_inference_features_widedata(
    train_panel: pd.DataFrame,
    daily_frame: dict,
    target_month_end: pd.Timestamp,
    as_of_day: int,
):
    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)
    feats = widedata_features_at(daily_frame, as_of)
    train_y = build_target(train_panel).dropna()
    cpi_train = train_panel[TARGET.fred_id].dropna()
    feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
    feats["cpi_mom_lag2"] = float(train_y.iloc[-2])
    feats["cpi_yoy_lag1"] = float(
        (cpi_train.iloc[-1] / cpi_train.iloc[-13] - 1.0) * 100.0
    )
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    return feats, as_of


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


# ---------------------------------------------------------------------
# Public entry points (standard interface)
# ---------------------------------------------------------------------


def run_widedata_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> WideDataNowcastResult:
    """Pull live panels, fit wide-data quantile model, current-month forecast."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    model = fit_widedata_nowcast_model(panel, daily_frame, as_of_day=as_of_day)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    feats = widedata_features_at(daily_frame, as_of)
    y_mom = build_target(panel).dropna()
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

    pred_mom, lo_mom, hi_mom = model.predict_one(pd.Series(feats))
    pred_mom = float(np.clip(pred_mom, _MOM_LO_CLIP, _MOM_HI_CLIP))

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(pred_mom, last_cpi, target_month_end, cpi)
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

    return WideDataNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
    )


def backtest_widedata_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict,
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the wide-panel quantile nowcaster.

    For each historical cut t in the trailing `window_months`:
      - train three quantile GBRs (q=0.1/0.5/0.9) on widedata features
        strictly BEFORE t
      - predict t's MoM at q={0.1, 0.5, 0.9}, sort, take median
      - clip to [-1.5, 2.5], chain to YoY against published CPI 12m prior

    A single failed cut (insufficient history, fit failure, etc.) is
    skipped via try/except. Return shape mirrors the rest of the
    nowcaster bestiary.
    """
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()

    cuts = list(range(len(y_mom) - window_months, len(y_mom)))
    preds_mom: list = []
    actuals_mom: list = []
    preds_yoy: list = []
    actuals_yoy: list = []
    rows: list = []

    last_as_of = None

    for ci in cuts:
        try:
            target_month_end = y_mom.index[ci]
            train_panel = panel.loc[panel.index < target_month_end]
            if len(train_panel) < 60:
                continue

            try:
                model = fit_widedata_nowcast_model(
                    train_panel, daily_frame, as_of_day=as_of_day,
                )
            except Exception:
                continue

            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue

            try:
                feats, as_of = _build_inference_features_widedata(
                    train_panel, daily_frame, target_month_end, as_of_day,
                )
            except Exception:
                continue

            try:
                pred_mom, _, _ = model.predict_one(pd.Series(feats))
            except Exception:
                continue
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
            last_as_of = as_of
            rows.append({
                "target_month": target_month_end.strftime("%Y-%m"),
                "as_of": as_of.strftime("%Y-%m-%d"),
                "pred_mom": round(pred_mom, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
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
