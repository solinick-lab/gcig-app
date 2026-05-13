"""Feature-cross nowcaster: pairwise products of acceleration features.

Hypothesis: Yellen 1.1 (clev_calibrated) treats each acceleration feature
independently. But accelerations interact — e.g. oil momentum diffs only
matter when their direction agrees with shelter momentum, and Cleveland's
"yoy_minus_lag" only matters when recent within-month MoM volatility
confirms the regime shift. Pairwise products of the most informative
acceleration features create explicit interaction terms that a depth-3
GBR cannot fully recover on its own from a wide kitchen-sink set
(boosting tends to allocate splits to high-marginal-info features and
under-explores low-marginal but high-interaction-info features).

Strategy:
  1. Build the same supervised matrix as Yellen 1.1 (clev features +
     rich features + CPI lags + seasonality).
  2. Identify the "acceleration" feature subset: features that encode
     short-vs-long momentum differences (`accel_7v7`, `clev_yoy_minus_lag`,
     `clev_mom`, `clev_core_mom`, `clev_next_mom`, plus synthetic
     momentum-diff features `<sid>_mom3_minus_mom21` and
     `<sid>_mom7_minus_mom14`). Acceleration ≡ change-of-change.
  3. Score each acceleration feature by GBR feature_importances_ on the
     training matrix (q=0.5 LS GBR — short, depth-3). Keep top-5.
  4. Generate all C(5,2)=10 pairwise products. Center each acceleration
     feature on its training mean before multiplying so that the cross
     captures co-movement (not level x level shrunk by means). Append
     these 10 cross features to X.
  5. Fit q={0.1, 0.5, 0.9} GBR with the same shape as Yellen 1.0
     (n_estimators=400, max_depth=3, lr=0.05).
  6. At inference, build the same cross features using the SAME training
     means and the SAME selected pair list, so OOS features align.

Public API:
  backtest_crossfeat_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_crossfeat_nowcast(as_of_day=20) -> CrossFeatNowcastResult

Each cut wrapped in try/except. MoM clipped to [-1.5, 2.5].
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
from .nowcast_clev import (
    _safe_get_clev,
    _clev_features_for_month,
    _build_supervised_clev,
    _fit_quantile_models,
    _predict_triple,
    _mom_to_yoy,
    _MOM_LO_CLIP,
    _MOM_HI_CLIP,
    _RESID_FLOOR,
    _QUANTILES,
    _GBR_PARAMS,
)


warnings.filterwarnings("ignore")


# --- constants -------------------------------------------------------

_TOP_K_ACCEL = 5  # take top-5 acceleration features by importance
_CROSS_PREFIX = "xprod__"

# Substrings that mark a feature as encoding an "acceleration" (i.e. a
# short-vs-long momentum gap or change-of-change). We deliberately keep
# this list tight so the importance ranking is on a homogeneous pool.
_ACCEL_SUBSTRINGS: tuple[str, ...] = (
    "accel_7v7",          # rich-features 7d-vs-prior-7d
    "clev_yoy_minus_lag", # Cleveland YoY vs last released YoY
    "clev_mom",           # Cleveland's MoM nowcast (recent inflation impulse)
    "clev_core_mom",      # core MoM
    "clev_next_mom",      # next-month MoM (additional accel signal)
    "_mom3_minus_mom21",  # synthetic diff features (added below)
    "_mom7_minus_mom14",  # synthetic diff features (added below)
)


@dataclass
class CrossFeatNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    n_cross_features: int
    selected_accel_features: list[str]


# ---------------------------------------------------------------------------
# Acceleration feature engineering
# ---------------------------------------------------------------------------


def _add_synthetic_accel_features(X: pd.DataFrame) -> pd.DataFrame:
    """Append <sid>_mom3_minus_mom21 and <sid>_mom7_minus_mom14 columns.

    These are explicit "short-window MINUS long-window momentum" features —
    classic acceleration definitions. Created in-place by walking columns
    that match `<sid>_mom<N>` patterns (rich-features per-series momentum
    windows). Pure addition — does not remove any columns.
    """
    cols = list(X.columns)
    # Group columns by series-id prefix (everything before "_mom<N>")
    by_sid: dict[str, dict[int, str]] = {}
    for c in cols:
        # match suffix like _mom3, _mom7, _mom14, _mom21
        for n in (3, 7, 14, 21):
            suffix = f"_mom{n}"
            if c.endswith(suffix):
                sid = c[: -len(suffix)]
                by_sid.setdefault(sid, {})[n] = c
                break

    new_cols: dict[str, pd.Series] = {}
    for sid, ns in by_sid.items():
        if 3 in ns and 21 in ns:
            new_cols[f"{sid}_mom3_minus_mom21"] = X[ns[3]] - X[ns[21]]
        if 7 in ns and 14 in ns:
            new_cols[f"{sid}_mom7_minus_mom14"] = X[ns[7]] - X[ns[14]]

    if not new_cols:
        return X
    new_df = pd.DataFrame(new_cols, index=X.index)
    return pd.concat([X, new_df], axis=1)


def _is_accel_feature(name: str) -> bool:
    """True if the feature name encodes an acceleration / momentum-diff."""
    return any(sub in name for sub in _ACCEL_SUBSTRINGS)


def _rank_accel_features(
    X: pd.DataFrame,
    y: pd.Series,
    top_k: int = _TOP_K_ACCEL,
) -> list[str]:
    """Fit a small LS GBR; rank acceleration features by importance.

    We fit on ALL columns (so the model sees the full info set when
    deciding how to use each accel feature), but only consider accel
    features when building the ranking. This avoids picking accel
    features that were artificially boosted because non-accel features
    were absent.
    """
    accel_cols = [c for c in X.columns if _is_accel_feature(c)]
    if not accel_cols:
        return []
    if len(accel_cols) <= top_k:
        return accel_cols
    try:
        Xv = np.nan_to_num(X.values.astype(float), nan=0.0, posinf=0.0, neginf=0.0)
        yv = y.values.astype(float)
        gbr = GradientBoostingRegressor(
            n_estimators=200,
            max_depth=3,
            learning_rate=0.05,
            random_state=42,
        ).fit(Xv, yv)
        importances = dict(zip(list(X.columns), gbr.feature_importances_))
        ranked = sorted(
            accel_cols, key=lambda c: importances.get(c, 0.0), reverse=True,
        )
        return ranked[:top_k]
    except Exception:
        return accel_cols[:top_k]


def _build_cross_features(
    X: pd.DataFrame,
    selected: list[str],
    means: dict[str, float],
) -> tuple[pd.DataFrame, list[tuple[str, str]]]:
    """Append C(k,2) pairwise products to X.

    Each base feature is centered on its training mean before multiplying.
    Returns the augmented frame and the list of (a, b) pairs used (so
    inference can reconstruct the same crosses).
    """
    if len(selected) < 2:
        return X, []
    pairs: list[tuple[str, str]] = []
    cross_cols: dict[str, pd.Series] = {}
    for i in range(len(selected)):
        for j in range(i + 1, len(selected)):
            a, b = selected[i], selected[j]
            if a not in X.columns or b not in X.columns:
                continue
            ca = X[a].astype(float) - float(means.get(a, 0.0))
            cb = X[b].astype(float) - float(means.get(b, 0.0))
            cname = f"{_CROSS_PREFIX}{a}__x__{b}"
            cross_cols[cname] = ca * cb
            pairs.append((a, b))
    if not cross_cols:
        return X, pairs
    cross_df = pd.DataFrame(cross_cols, index=X.index)
    return pd.concat([X, cross_df], axis=1), pairs


def _apply_cross_features_inference(
    feats: dict[str, float],
    pairs: list[tuple[str, str]],
    means: dict[str, float],
) -> dict[str, float]:
    """Add cross features to an inference dict using the saved means/pairs."""
    out = dict(feats)
    for (a, b) in pairs:
        va = float(out.get(a, 0.0))
        vb = float(out.get(b, 0.0))
        if not np.isfinite(va):
            va = 0.0
        if not np.isfinite(vb):
            vb = 0.0
        ca = va - float(means.get(a, 0.0))
        cb = vb - float(means.get(b, 0.0))
        out[f"{_CROSS_PREFIX}{a}__x__{b}"] = ca * cb
    return out


# ---------------------------------------------------------------------------
# Augmented supervised dataset
# ---------------------------------------------------------------------------


def _build_supervised_crossfeat(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    as_of_day: int,
) -> tuple[pd.DataFrame, pd.Series, list[str], dict[str, float], list[tuple[str, str]]]:
    """Yellen 1.1 supervised set + synthetic accel diffs + top-5 cross products.

    Returns (X_aug, y, selected_accel_features, training_means, pairs).
    """
    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    if len(X) == 0:
        return X, y, [], {}, []

    # Inject synthetic momentum-diff features so the importance scorer can
    # see them as candidates.
    X = _add_synthetic_accel_features(X)

    # Re-fill (the new columns may have NaNs from missing window data).
    X = X.fillna(X.median(numeric_only=True)).fillna(0.0)

    # Rank acceleration features and build crosses.
    selected = _rank_accel_features(X, y, top_k=_TOP_K_ACCEL)
    means = {c: float(X[c].mean()) for c in selected if c in X.columns}
    X_aug, pairs = _build_cross_features(X, selected, means)
    X_aug = X_aug.fillna(X_aug.median(numeric_only=True)).fillna(0.0)
    return X_aug, y, selected, means, pairs


def _build_inference_features_crossfeat(
    train_panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    target_month_end: pd.Timestamp,
    as_of_day: int,
    cols: list[str],
    X_train: pd.DataFrame,
    selected: list[str],
    means: dict[str, float],
    pairs: list[tuple[str, str]],
) -> pd.Series:
    """Recreate the inference feature vector matching the augmented X."""
    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)
    feats = rich_features_at(daily_frame, as_of)

    train_y = build_target(train_panel).dropna()
    if len(train_y) >= 1:
        feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
    if len(train_y) >= 2:
        feats["cpi_mom_lag2"] = float(train_y.iloc[-2])

    cpi_train = train_panel[TARGET.fred_id].dropna()
    if len(cpi_train) >= 13:
        feats["cpi_yoy_lag1"] = float(
            (cpi_train.iloc[-1] / cpi_train.iloc[-13] - 1.0) * 100.0
        )

    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

    try:
        feats.update(_clev_features_for_month(clev, target_month_end, train_panel))
    except Exception:
        pass

    # Add the synthetic <sid>_mom3_minus_mom21 / _mom7_minus_mom14 features
    # using the SAME inference mom values that the training pipeline would
    # have computed (pulled directly from rich_features_at output above).
    for sid_n in list(feats.keys()):  # snapshot — we mutate feats below
        pass
    # Walk every key like "<sid>_mom<N>" and synthesize diffs.
    by_sid: dict[str, dict[int, float]] = {}
    for k, v in feats.items():
        for n in (3, 7, 14, 21):
            suffix = f"_mom{n}"
            if k.endswith(suffix):
                sid = k[: -len(suffix)]
                by_sid.setdefault(sid, {})[n] = float(v) if np.isfinite(v) else 0.0
                break
    for sid, ns in by_sid.items():
        if 3 in ns and 21 in ns:
            feats[f"{sid}_mom3_minus_mom21"] = ns[3] - ns[21]
        if 7 in ns and 14 in ns:
            feats[f"{sid}_mom7_minus_mom14"] = ns[7] - ns[14]

    # Append cross features using saved pairs/means.
    feats = _apply_cross_features_inference(feats, pairs, means)

    x_inf = pd.Series(feats)
    x_inf = x_inf.reindex(cols).fillna(X_train.median(numeric_only=True)).fillna(0.0)
    return x_inf


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def backtest_crossfeat_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of clev_nowcast + cross-feat acceleration products."""
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
    last_selected: list[str] = []

    for ci in cuts:
        try:
            target_month_end = y_mom.index[ci]
            train_panel = panel.loc[panel.index < target_month_end]
            if len(train_panel) < 60:
                continue

            X_aug, y, selected, means, pairs = _build_supervised_crossfeat(
                train_panel, daily_frame, clev, as_of_day=as_of_day,
            )
            if len(X_aug) < 24:
                continue

            models = _fit_quantile_models(X_aug, y)
            cols = list(X_aug.columns)
            last_selected = selected

            x_inf = _build_inference_features_crossfeat(
                train_panel,
                daily_frame,
                clev,
                target_month_end,
                as_of_day,
                cols,
                X_aug,
                selected,
                means,
                pairs,
            )

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
                "as_of": _as_of_for_month(
                    target_month_end + pd.offsets.MonthBegin(-1), as_of_day,
                ).strftime("%Y-%m-%d"),
                "pred_mom": round(mid, 4),
                "actual_mom": round(actual_mom, 4),
                "pred_yoy": round(pred_yoy, 3),
                "actual_yoy": round(actual_yoy, 3),
                "yoy_err": round(pred_yoy - actual_yoy, 3),
                "n_cross_features": len(pairs),
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
        "selectedAccelFeatures": last_selected,
        "rows": rows,
    }


def run_crossfeat_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> CrossFeatNowcastResult:
    """Live nowcast using cross-feat acceleration products."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X_aug, y, selected, means, pairs = _build_supervised_crossfeat(
        panel, daily_frame, clev, as_of_day=as_of_day,
    )
    models = _fit_quantile_models(X_aug, y)
    cols = list(X_aug.columns)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    x_inf = _build_inference_features_crossfeat(
        panel,
        daily_frame,
        clev,
        target_month_end,
        as_of_day,
        cols,
        X_aug,
        selected,
        means,
        pairs,
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

    return CrossFeatNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        n_cross_features=len(pairs),
        selected_accel_features=list(selected),
    )
