"""K-Nearest-Neighbors nowcaster anchored on Cleveland Fed similarity.

Hypothesis: when the current macroeconomic state — captured by Cleveland
Fed's nowcast YoY level, its 30-day slope (momentum), and the last
released BLS CPI YoY — closely matches a state observed in the past, the
ACTUAL MoM CPI print observed in that historical month is informative
about the print we'll see this month. We make the K=5 nearest historical
neighbors (Euclidean in standardized 3-feature space) into a quasi-
nonparametric forecaster, taking the median of their actual MoM
realizations as our point prediction.

Three features only (deliberately spare to keep neighborhoods stable):
  1. clev_yoy            — Cleveland's headline-CPI YoY nowcast at as-of
                            day-20 of the target month (vintage-correct
                            via `historical[YYYY-MM]`).
  2. clev_slope_30d      — clev_yoy[T] - clev_yoy[T-1]. Captures the
                            sign/size of the recent inflation impulse.
  3. cpi_yoy_lag1        — Headline CPI YoY at the most recently
                            released BLS print (T-1). The "where we
                            currently sit" anchor.

The neighbor index is built fresh per cut from prior-month rows ONLY
(strict walk-forward — no peeking). For each candidate row we compute
the same 3 features at the row's as-of-day-20 and pair it with the
ACTUAL MoM realized for that month. At inference, we standardize the
three query features using the train-set means/stds, find the K=5 rows
with the smallest standardized Euclidean distance, and predict the
median of their actual MoMs.

If Cleveland's scrape is unavailable for the target month, we fall back
to a FRED median-CPI proxy (matching the construction in
`nowcast_clev.py`) so the model degrades gracefully rather than aborting
the cut.

MoM clipped to [-1.5, 2.5]. Each cut wrapped in try/except. Return
shapes mirror `nowcast_clev.backtest_clev_nowcast` and
`nowcast_clev.run_clev_nowcast` so the harness can plug this in
unchanged.

Public API:
  backtest_knn_clev_nowcast(panel, daily_frame, window_months=24,
                            as_of_day=20, k=5) -> dict
  run_knn_clev_nowcast(as_of_day=20, k=5) -> KnnClevNowcastResult
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .api_client import get_daily_panel, get_cleveland_nowcast
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_MOM_LO_CLIP = -1.5
_MOM_HI_CLIP = 2.5
_RESID_FLOOR = 0.05
_DEFAULT_K = 5
_MIN_TRAIN_ROWS = 24

# FRED median CPI fallback (already in panel via EXTRA_SERIES). Mirrors
# the fallback in nowcast_clev.py / nowcast_clev_trajectory.py.
_FRED_MED_CPI = "MEDCPIM158SFRBCLE"


@dataclass
class KnnClevNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool


# ---------------------------------------------------------------------------
# Cleveland scrape helpers (lifted from nowcast_clev_trajectory.py shape)
# ---------------------------------------------------------------------------


def _safe_get_clev() -> dict:
    """Fetch Cleveland nowcast via API. Always returns a dict (never raises)."""
    try:
        return get_cleveland_nowcast()
    except Exception as exc:
        return {
            "ok": False,
            "fetchedAt": "",
            "asOfDate": None,
            "headline": {},
            "core": {},
            "historical": {},
            "error": str(exc),
        }


def _hist_entry(clev: dict, key: str) -> dict | None:
    """Pull historical[YYYY-MM] entry, or None if missing/malformed."""
    if not isinstance(clev, dict) or not clev.get("ok"):
        return None
    hist = clev.get("historical") or {}
    if not isinstance(hist, dict):
        return None
    entry = hist.get(key)
    if not isinstance(entry, dict):
        return None
    return entry


def _hist_yoy(clev: dict, key: str) -> float:
    """Cleveland headline YoY at historical[key], else np.nan."""
    entry = _hist_entry(clev, key)
    if entry is None:
        return float("nan")
    v = entry.get("yoy")
    if isinstance(v, (int, float)) and np.isfinite(v):
        return float(v)
    return float("nan")


def _live_yoy_for_target(clev: dict, target_key: str) -> float:
    """If the live currentMonth/nextMonth slot matches `target_key`, return
    its headline YoY. Used when historical[T] hasn't been populated yet
    (i.e. live current-month forecasting)."""
    if not isinstance(clev, dict) or not clev.get("ok"):
        return float("nan")
    for slot in ("currentMonth", "nextMonth"):
        head = (clev.get("headline") or {}).get(slot) or {}
        if head.get("month") == target_key:
            v = head.get("yoy")
            if isinstance(v, (int, float)) and np.isfinite(v):
                return float(v)
    return float("nan")


# ---------------------------------------------------------------------------
# Three-feature builder (exactly the spec)
# ---------------------------------------------------------------------------


def _three_features_for_month(
    clev: dict,
    target_month_end: pd.Timestamp,
    panel: pd.DataFrame,
) -> dict[str, float]:
    """Build the 3 KNN features for one target month, vintage-correct.

    Returns dict with keys: clev_yoy, clev_slope_30d, cpi_yoy_lag1, used_scrape.

    `clev_yoy` is Cleveland's headline-CPI YoY nowcast as published at
    ~day-20 of `target_month_end`. We pull this from the
    `historical[YYYY-MM]` archive in the scrape response (vintage-
    correct). For the live current-month case we accept the live
    `currentMonth` slot if its `month` field matches.

    `clev_slope_30d` is clev_yoy[T] - clev_yoy[T-1] using the historical
    archive entry for the prior month (also a day-20 vintage). When
    either is missing the slope is NaN.

    `cpi_yoy_lag1` is the most recently released BLS headline CPI YoY at
    the time of as-of-day-20 — i.e. the prior month's BLS print. This is
    always observable from `panel[TARGET.fred_id]` truncated to
    `target_month_end - 1 month`.

    `used_scrape` is 1.0 if `clev_yoy` came from the live scrape, else
    0.0 (i.e. came from the FRED median-CPI fallback).
    """
    feats: dict[str, float] = {
        "clev_yoy": float("nan"),
        "clev_slope_30d": float("nan"),
        "cpi_yoy_lag1": float("nan"),
        "used_scrape": 0.0,
    }

    target_key = target_month_end.strftime("%Y-%m")
    t_start = target_month_end + pd.offsets.MonthBegin(-1)
    prior_1_key = (t_start + pd.offsets.MonthBegin(-1)).strftime("%Y-%m")

    # --- clev_yoy[T] -----------------------------------------------------
    yoy_t = _hist_yoy(clev, target_key)
    if not np.isfinite(yoy_t):
        # Try live currentMonth/nextMonth slots (covers live forecasts
        # where historical[T] hasn't been populated yet).
        yoy_t = _live_yoy_for_target(clev, target_key)

    if np.isfinite(yoy_t):
        feats["clev_yoy"] = yoy_t
        feats["used_scrape"] = 1.0
    else:
        # FRED median-CPI fallback. Reconstruct an estimate of headline
        # YoY by adding the BLS-vs-median wedge to median YoY (mirrors
        # the construction in nowcast_clev.py).
        try:
            if _FRED_MED_CPI in panel.columns:
                s = panel[_FRED_MED_CPI].dropna()
                last_released = (
                    target_month_end + pd.offsets.MonthBegin(-1)
                    - pd.Timedelta(days=1)
                ) + pd.offsets.MonthEnd(0)
                prior = s.loc[s.index <= last_released]
                if len(prior) >= 13:
                    med_yoy = float(
                        (prior.iloc[-1] / prior.iloc[-13] - 1.0) * 100.0
                    )
                    cpi = panel[TARGET.fred_id].dropna()
                    cpi_prior = cpi.loc[cpi.index <= last_released]
                    if len(cpi_prior) >= 13:
                        head_yoy = float(
                            (cpi_prior.iloc[-1] / cpi_prior.iloc[-13] - 1.0)
                            * 100.0
                        )
                        wedge = head_yoy - med_yoy
                    else:
                        wedge = 0.0
                    feats["clev_yoy"] = med_yoy + wedge
        except Exception:
            pass

    # --- clev_slope_30d = clev_yoy[T] - clev_yoy[T-1] --------------------
    yoy_p1 = _hist_yoy(clev, prior_1_key)
    if np.isfinite(feats["clev_yoy"]) and np.isfinite(yoy_p1):
        feats["clev_slope_30d"] = feats["clev_yoy"] - yoy_p1

    # --- cpi_yoy_lag1: last-released BLS YoY ----------------------------
    try:
        cpi = panel[TARGET.fred_id].dropna()
        last_released = (
            target_month_end + pd.offsets.MonthBegin(-1)
            - pd.Timedelta(days=1)
        ) + pd.offsets.MonthEnd(0)
        cpi_prior = cpi.loc[cpi.index <= last_released]
        if len(cpi_prior) >= 13:
            feats["cpi_yoy_lag1"] = float(
                (cpi_prior.iloc[-1] / cpi_prior.iloc[-13] - 1.0) * 100.0
            )
    except Exception:
        pass

    return feats


# ---------------------------------------------------------------------------
# Build the historical neighbor index
# ---------------------------------------------------------------------------


def _build_neighbor_index(
    panel: pd.DataFrame,
    clev: dict,
    as_of_day: int,
    min_history_months: int = 36,
    upper_bound_month_end: pd.Timestamp | None = None,
) -> tuple[np.ndarray, np.ndarray, list[pd.Timestamp]]:
    """Compute (X3, y_mom, months) over candidate historical months.

    For each eligible past month T we compute the 3 features as they'd
    have looked at as-of day-20 of T (vintage-correct) and pair them
    with the ACTUAL MoM CPI print for T. Rows with any NaN feature or
    NaN target are dropped.

    `upper_bound_month_end`: if set, only include months with month_end
    STRICTLY BEFORE this date. Use the target month_end during backtest
    so we never train on the answer.
    """
    y_mom_full = build_target(panel).dropna()
    eligible = y_mom_full.index[min_history_months:]

    feats_rows: list[list[float]] = []
    targets: list[float] = []
    months: list[pd.Timestamp] = []

    for month_end in eligible:
        if upper_bound_month_end is not None and month_end >= upper_bound_month_end:
            continue
        try:
            f = _three_features_for_month(clev, month_end, panel)
        except Exception:
            continue
        x = (f["clev_yoy"], f["clev_slope_30d"], f["cpi_yoy_lag1"])
        if not all(np.isfinite(v) for v in x):
            continue
        try:
            y_val = float(y_mom_full.loc[month_end])
        except Exception:
            continue
        if not np.isfinite(y_val):
            continue
        feats_rows.append([x[0], x[1], x[2]])
        targets.append(y_val)
        months.append(month_end)

    if not feats_rows:
        return (
            np.zeros((0, 3), dtype=float),
            np.zeros((0,), dtype=float),
            [],
        )

    return (
        np.asarray(feats_rows, dtype=float),
        np.asarray(targets, dtype=float),
        months,
    )


# ---------------------------------------------------------------------------
# K-NN core
# ---------------------------------------------------------------------------


def _standardize(
    X: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Column-wise standardize. Returns (Z, mu, sigma) with sigma>=eps."""
    mu = X.mean(axis=0)
    sigma = X.std(axis=0, ddof=0)
    sigma = np.where(sigma > 1e-9, sigma, 1.0)
    Z = (X - mu) / sigma
    return Z, mu, sigma


def _knn_predict(
    X_train: np.ndarray,
    y_train: np.ndarray,
    x_query: np.ndarray,
    k: int,
) -> tuple[float, list[int]]:
    """Standardized Euclidean K-NN. Returns (median, neighbor_indices).

    K is clipped to len(X_train) when training is small.
    """
    Z_train, mu, sigma = _standardize(X_train)
    z_query = (x_query - mu) / sigma
    # Squared euclidean is sufficient for ranking.
    d2 = np.sum((Z_train - z_query) ** 2, axis=1)
    k_eff = max(1, min(k, len(Z_train)))
    # argpartition for the k smallest, then sort that subset for reproducibility.
    idx_part = np.argpartition(d2, k_eff - 1)[:k_eff]
    idx_sorted = idx_part[np.argsort(d2[idx_part])]
    neighbors_y = y_train[idx_sorted]
    return float(np.median(neighbors_y)), idx_sorted.tolist()


def _knn_residual_quantiles(
    X_train: np.ndarray,
    y_train: np.ndarray,
    leave_one_out_k: int,
) -> tuple[float, float]:
    """Compute (q10, q90) of in-sample leave-one-out KNN residuals.

    Used to size the 80% YoY uncertainty band in `run_knn_clev_nowcast`
    so the wrapper has SOMETHING to report. Falls back to (-0.3, +0.3)
    if the train set is too small.
    """
    n = len(X_train)
    if n < 10:
        return -0.3, 0.3
    residuals: list[float] = []
    Z, mu, sigma = _standardize(X_train)
    for i in range(n):
        z_q = Z[i]
        # Mask out i itself.
        d2 = np.sum((Z - z_q) ** 2, axis=1)
        d2[i] = np.inf
        k_eff = max(1, min(leave_one_out_k, n - 1))
        idx_part = np.argpartition(d2, k_eff - 1)[:k_eff]
        pred = float(np.median(y_train[idx_part]))
        residuals.append(y_train[i] - pred)
    if not residuals:
        return -0.3, 0.3
    arr = np.asarray(residuals)
    q10 = float(np.quantile(arr, 0.10))
    q90 = float(np.quantile(arr, 0.90))
    return q10, q90


# ---------------------------------------------------------------------------
# MoM -> YoY translation (mirrors nowcast_clev._mom_to_yoy)
# ---------------------------------------------------------------------------


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


def backtest_knn_clev_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
    k: int = _DEFAULT_K,
) -> dict:
    """Walk-forward backtest using 3-feature K-NN over Cleveland history.

    `daily_frame` is accepted for harness-compatibility (mirrors the
    other Cleveland nowcasters' signature) but isn't consumed — the
    K-NN backbone operates on monthly-vintage Cleveland data only.

    Calls the Cleveland scrape ONCE up-front. The historical archive
    inside that single response covers all cuts.
    """
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

            # Build neighbor index over PAST months only (strict
            # walk-forward) — months with month_end < target_month_end.
            X_train, y_train, _months = _build_neighbor_index(
                train_panel, clev, as_of_day=as_of_day,
                upper_bound_month_end=target_month_end,
            )
            if len(X_train) < _MIN_TRAIN_ROWS:
                continue

            # Build the query features for THIS target month.
            q_feats = _three_features_for_month(clev, target_month_end, panel)
            x_q = np.array(
                [q_feats["clev_yoy"], q_feats["clev_slope_30d"],
                 q_feats["cpi_yoy_lag1"]],
                dtype=float,
            )
            # If any query feature is NaN we can't form a neighborhood —
            # impute with the train median so the cut still returns
            # rather than silently dropping it.
            if not np.all(np.isfinite(x_q)):
                medians = np.nanmedian(X_train, axis=0)
                x_q = np.where(np.isfinite(x_q), x_q, medians)

            mid, neighbor_idx = _knn_predict(X_train, y_train, x_q, k)
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

            m_start = target_month_end + pd.offsets.MonthBegin(-1)
            as_of = _as_of_for_month(m_start, as_of_day)

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
                "neighbors": len(neighbor_idx),
                "trainRows": int(len(X_train)),
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
        "k": int(k),
        "totalCuts": len(preds_mom),
        "rmseMom": float(np.sqrt(np.mean((pm - am) ** 2))),
        "rmseYoy": float(np.sqrt(np.mean((py - ay) ** 2))),
        "maeYoy": float(np.mean(yoy_err)),
        "hitWithin25bp": float((yoy_err <= 0.25).mean()) * 100,
        "hitWithin50bp": float((yoy_err <= 0.50).mean()) * 100,
        "usedClevScrape": used_scrape,
        "rows": rows,
    }


def run_knn_clev_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
    k: int = _DEFAULT_K,
) -> KnnClevNowcastResult:
    """Live nowcast using fresh Cleveland scrape + K-NN over 3 features."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

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

    # Build neighbor index over ALL prior months.
    X_train, y_train, _months = _build_neighbor_index(
        panel, clev, as_of_day=as_of_day,
        upper_bound_month_end=target_month_end,
    )

    # Query features for the live target.
    q_feats = _three_features_for_month(clev, target_month_end, panel)
    x_q = np.array(
        [q_feats["clev_yoy"], q_feats["clev_slope_30d"],
         q_feats["cpi_yoy_lag1"]],
        dtype=float,
    )
    if len(X_train) >= 1 and not np.all(np.isfinite(x_q)):
        medians = np.nanmedian(X_train, axis=0)
        x_q = np.where(np.isfinite(x_q), x_q, medians)

    if len(X_train) < 1 or not np.all(np.isfinite(x_q)):
        # Pathological fallback: predict zero MoM. The wrapper still
        # returns a well-formed object.
        mid = 0.0
        q10_resid, q90_resid = -0.3, 0.3
    else:
        mid, _idx = _knn_predict(X_train, y_train, x_q, k)
        mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))
        q10_resid, q90_resid = _knn_residual_quantiles(
            X_train, y_train, leave_one_out_k=k,
        )

    last_cpi = float(cpi.iloc[-1])
    pred_yoy = _mom_to_yoy(mid, last_cpi, target_month_end, cpi)
    lo80_yoy = _mom_to_yoy(mid + q10_resid, last_cpi, target_month_end, cpi)
    hi80_yoy = _mom_to_yoy(mid + q90_resid, last_cpi, target_month_end, cpi)

    if (hi80_yoy - pred_yoy) < _RESID_FLOOR:
        hi80_yoy = pred_yoy + _RESID_FLOOR
    if (pred_yoy - lo80_yoy) < _RESID_FLOOR:
        lo80_yoy = pred_yoy - _RESID_FLOOR

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(
            s.loc[(s.index >= target_month_start) & (s.index <= as_of)]
        ) > 0
    )
    return KnnClevNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
    )
