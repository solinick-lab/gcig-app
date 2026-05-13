"""GAM-style (Generalized Additive Model) nowcaster.

Hypothesis: Yellen 1.1 (`clev_calibrated`) uses a quantile-GBR over a
mixed feature set + a tiny Ridge bias-correction. Its YoY MAE on the
24-month walk-forward backtest is ~0.1142. The GBR is flexible but
"black box" — it can mix features in arbitrary, non-additive ways and
must learn smooth feature responses purely from sample splits.

A GAM imposes an INDUCTIVE BIAS that better matches CPI structure:

        y_mom = beta0 + f1(x1) + f2(x2) + ... + fK(xK) + epsilon

where each `fk` is a smooth (B-spline degree-3) univariate response on
ONE input feature. There are NO interactions. CPI nowcast residuals
are dominated by additive contributions of: prior MoM, prior YoY,
Cleveland nowcast (yoy/mom), oil pass-through, breakeven inflation,
gas, MICH inflation expectations, and the Cleveland-vs-lag wedge.
Each of those is approximately additive and (mildly) nonlinear in
isolation. A GAM captures that without burning degrees of freedom on
spurious interactions.

Approximation in sklearn (no `pyGAM` dependency):

  1. Build `_build_supervised_clev` (Yellen 1.1's feature matrix).
  2. Use a small GradientBoostingRegressor to RANK features by
     `feature_importances_`; keep the top-15 (tractability cap).
  3. Wrap each top feature in a `SplineTransformer(degree=3, n_knots=4,
     knots="quantile", extrapolation="constant")`. With degree=3 and
     n_knots=4 a single column expands to ~6 basis columns
     (n_knots + degree - 1). 15 features → ~90 basis columns.
  4. ColumnTransformer applies per-feature splines (each in its own
     transformer slot — that's what makes this GAM-shaped: no cross
     features, only additive bases).
  5. StandardScaler → LassoCV. Lasso induces SPARSITY on the basis
     columns: many bases collapse to zero, so the implied f_k is the
     simplest curve that explains its feature's marginal contribution.
     5-fold CV on alpha picks the regularization strength per cut.
  6. Point prediction = LassoCV.predict. 80% bands = z * residual_std
     (gaussian approximation on in-sample residuals; floored).

Why this can beat 0.1142:
  - Yellen 1.1's GBR over-fits some of the 24-row backtest bias via
    interactions; an additive structure is a more conservative model
    that should generalize slightly better on the small OOS window.
  - Lasso on basis columns acts like soft-select on KNOT KNEES per
    feature, so each f_k auto-selects its own complexity.
  - Same input rows, same target, same mom→yoy conversion as 1.1 — the
    only difference is the regression mechanism, so the comparison is
    apples-to-apples.

Public API (mirrors the standard nowcast pattern):
  backtest_gam_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_gam_nowcast(as_of_day=20) -> GamNowcastResult

Robustness: every cut wrapped in try/except. MoM clipped to clev's
[_MOM_LO_CLIP, _MOM_HI_CLIP]. YoY band-floor inherited from clev base
(`_RESID_FLOOR`). If we run out of clean training rows on a cut, we
skip it (caller drops the cut from the metric).
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.linear_model import LassoCV
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

_TOP_K = 15            # how many features to spline-expand (tractability cap)
_SPLINE_DEGREE = 3     # cubic B-spline basis
_SPLINE_N_KNOTS = 4    # quantile-spaced knots per feature
_LASSO_CV_FOLDS = 5
_LASSO_MAX_ITER = 10_000
_LASSO_N_ALPHAS = 60

_Z_80 = 1.2816         # one-sided 90th pct of N(0,1) → symmetric 80% band
_RESID_STD_FLOOR = 0.05  # floor on in-sample residual std (MoM)

# GBR used purely for ranking features (NOT prediction); kept very
# small/cheap because we re-fit it per cut.
_RANKER_PARAMS = dict(
    n_estimators=200,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)


@dataclass
class GamNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool
    n_top_feats: int
    n_active_basis: int
    n_train_rows: int


# ---------------------------------------------------------------------------
# Feature ranking
# ---------------------------------------------------------------------------


def _rank_top_features(
    X: pd.DataFrame, y: pd.Series, k: int = _TOP_K,
) -> list[str]:
    """Rank columns of X by GBR feature_importances_ on (X, y); keep top-k.

    We deliberately use a small/fast GBR (NOT the prediction model) just
    to score importances. Falls back to the first k columns of X if the
    GBR fit raises (extremely defensive — we don't want to bring down
    the whole nowcaster on a numerical hiccup).
    """
    cols = list(X.columns)
    if len(cols) <= k:
        return cols
    try:
        Xv = np.nan_to_num(
            X.values.astype(float), nan=0.0, posinf=0.0, neginf=0.0,
        )
        gbr = GradientBoostingRegressor(**_RANKER_PARAMS).fit(
            Xv, y.values.astype(float),
        )
        importances = gbr.feature_importances_
        ranked = sorted(
            zip(cols, importances), key=lambda p: p[1], reverse=True,
        )
        chosen = [c for c, imp in ranked if imp > 0][:k]
        if len(chosen) < min(k, 8):
            # Pad with non-zero-importance fallthroughs to hit k where possible
            extras = [c for c, _ in ranked if c not in chosen]
            chosen = (chosen + extras)[:k]
        return chosen
    except Exception:
        return cols[:k]


# ---------------------------------------------------------------------------
# Pipeline construction
# ---------------------------------------------------------------------------


def _splineable(col: pd.Series) -> bool:
    """A column is spline-expandable iff it has variance and ≥ 2 unique values."""
    try:
        if col.notna().sum() < 2:
            return False
        if float(np.nanstd(col.values)) < 1e-9:
            return False
        # Need enough unique values for n_knots quantile-spaced knots
        if col.dropna().nunique() < _SPLINE_N_KNOTS:
            return False
        return True
    except Exception:
        return False


def _build_gam_pipeline(top_feats: list[str]) -> Pipeline:
    """Per-feature SplineTransformer in a ColumnTransformer + LassoCV.

    Each top feature gets its OWN SplineTransformer slot (additive
    structure — no cross terms). Non-top features are dropped (they
    were ranked out by the GBR ranker). LassoCV then induces sparsity
    on basis columns, which is the GAM's complexity controller.
    """
    transformers: list[tuple] = []
    for c in top_feats:
        spline = SplineTransformer(
            degree=_SPLINE_DEGREE,
            n_knots=_SPLINE_N_KNOTS,
            knots="quantile",
            extrapolation="constant",
            include_bias=False,
        )
        # Each feature gets its own named slot — that's what makes this
        # additive: no ColumnTransformer slot mixes two raw features.
        safe_name = f"sp_{c}".replace("-", "_").replace(".", "_")
        transformers.append((safe_name, spline, [c]))

    if not transformers:
        # Degenerate fallback — no spline-able features. Fit a trivial
        # passthrough so the pipeline still runs (predictions will be ~0).
        transformers = [("pass", "passthrough", top_feats or ["__none__"])]

    pre = ColumnTransformer(transformers=transformers, remainder="drop")

    lasso = LassoCV(
        cv=_LASSO_CV_FOLDS,
        max_iter=_LASSO_MAX_ITER,
        n_alphas=_LASSO_N_ALPHAS,
        fit_intercept=True,
        random_state=42,
    )

    return Pipeline(steps=[
        ("pre", pre),
        ("scaler", StandardScaler(with_mean=True, with_std=True)),
        ("lasso", lasso),
    ])


def _fit_gam_model(
    X: pd.DataFrame, y: pd.Series,
) -> tuple[Pipeline, float, list[str], int]:
    """Rank top features → spline-expand → LassoCV.

    Returns (pipeline, residual_std, top_feats_used, n_active_basis).
    """
    # 1) Rank top features by GBR importance on the full matrix.
    top_candidates = _rank_top_features(X, y, k=_TOP_K)
    # 2) Filter to spline-expandable columns (variance + uniqueness check).
    top_feats = [c for c in top_candidates if _splineable(X[c])]
    if not top_feats:
        # Defensive fallback — keep whichever rank-survivors exist (will
        # likely fail upstream but avoids a hard crash on edge data).
        top_feats = top_candidates[:1]

    pipe = _build_gam_pipeline(top_feats)

    Xv = X[top_feats].copy()
    medians = Xv.median(numeric_only=True)
    Xv = Xv.fillna(medians).fillna(0.0)

    pipe.fit(Xv, y.values)
    in_sample = pipe.predict(Xv)
    resid = y.values - in_sample

    if len(resid) > 1:
        resid_std = float(np.std(resid, ddof=1))
    else:
        resid_std = _RESID_STD_FLOOR
    if not np.isfinite(resid_std) or resid_std < _RESID_STD_FLOOR:
        resid_std = _RESID_STD_FLOOR

    # Count active (non-zero) basis columns from the LassoCV fit — this
    # is the effective complexity of the GAM after sparsity selection.
    try:
        coef = pipe.named_steps["lasso"].coef_
        n_active = int(np.sum(np.abs(coef) > 1e-12))
    except Exception:
        n_active = -1

    return pipe, resid_std, top_feats, n_active


def _predict_with_bands(
    pipe: Pipeline,
    x_inf: pd.Series,
    top_feats: list[str],
    resid_std: float,
) -> tuple[float, float, float]:
    """Return (mid, lo80, hi80) in MoM space."""
    row = x_inf.reindex(top_feats).to_frame().T
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


def backtest_gam_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the GAM-style nowcaster.

    For each cut:
      1. Train Yellen 1.1's `_build_supervised_clev` matrix on the
         training window.
      2. Rank features → keep top-15 by GBR importance.
      3. Per-feature SplineTransformer + LassoCV on the basis columns.
      4. Predict at inference; clip MoM; convert to YoY using the
         clev rule (`_mom_to_yoy`); compute YoY error vs. actual.

    Returns a dict shaped like `nowcast.backtest_nowcast` plus a few
    diagnostic columns (n_top_feats, n_active_basis, resid_std).
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

            X, y = _build_supervised_clev(
                train_panel, daily_frame, clev, as_of_day=as_of_day,
            )
            if len(X) < 24:
                continue

            pipe, resid_std, top_feats, n_active = _fit_gam_model(X, y)

            # --- inference features (same recipe as Yellen 1.1) ---
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
                (train_panel[TARGET.fred_id].dropna().iloc[-1]
                 / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0)
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
                    _clev_features_for_month(clev, target_month_end, panel)
                )
            except Exception:
                pass

            # Reindex inference row strictly to the top_feats columns
            # (the only ones the pipeline was fit on).
            x_inf = pd.Series(feats)
            train_medians = X[top_feats].median(numeric_only=True)
            x_inf = x_inf.reindex(top_feats).fillna(train_medians).fillna(0.0)

            mid, lo_mom, hi_mom = _predict_with_bands(
                pipe, x_inf, top_feats, resid_std,
            )
            mid = float(np.clip(mid, _MOM_LO_CLIP, _MOM_HI_CLIP))

            actual_mom = float(y_mom.iloc[ci])
            last_cpi_train = float(
                train_panel[TARGET.fred_id].dropna().iloc[-1]
            )
            pred_yoy = _mom_to_yoy(
                mid, last_cpi_train, target_month_end, cpi,
            )
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
                "n_top_feats": len(top_feats),
                "n_active_basis": n_active,
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


def run_gam_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> GamNowcastResult:
    """Live nowcast: fit GAM on full history, predict next-month MoM/YoY."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    X, y = _build_supervised_clev(
        panel, daily_frame, clev, as_of_day=as_of_day,
    )
    pipe, resid_std, top_feats, n_active = _fit_gam_model(X, y)

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

    y_mom = build_target(panel).dropna()
    feats = rich_features_at(daily_frame, as_of)
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    feats["cpi_yoy_lag1"] = float(
        (cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0
    )
    feats["month_sin"] = float(
        np.sin(2 * np.pi * target_month_end.month / 12.0)
    )
    feats["month_cos"] = float(
        np.cos(2 * np.pi * target_month_end.month / 12.0)
    )
    try:
        feats.update(_clev_features_for_month(clev, target_month_end, panel))
    except Exception:
        pass

    train_medians = X[top_feats].median(numeric_only=True)
    x_inf = pd.Series(feats).reindex(top_feats).fillna(train_medians).fillna(0.0)
    mid, lo_mom, hi_mom = _predict_with_bands(
        pipe, x_inf, top_feats, resid_std,
    )
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
        if len(
            s.loc[(s.index >= target_month_start) & (s.index <= as_of)]
        ) > 0
    )
    return GamNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
        n_top_feats=len(top_feats),
        n_active_basis=int(n_active),
        n_train_rows=int(len(X)),
    )
