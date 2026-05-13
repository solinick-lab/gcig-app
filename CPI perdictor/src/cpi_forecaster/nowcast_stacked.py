"""Stacked nowcaster ensemble — Agent NNN.

Builds a Ridge meta-learner over four base learners:
    - Ridge (existing baseline's Ridge)
    - GradientBoostingRegressor quantile-median (existing baseline's GBR)
    - XGBoost (new addition)
    - ElasticNet (new addition for regularization diversity)

OOF predictions for each base are generated via a TimeSeriesSplit with 5
folds — chosen to maximize OOF training rows for the meta (the historical
champion_v3 failure mode was that tiny OOF sets caused the meta to overfit
its three coefficients).

Inference path:
    1. Refit each base on the FULL training panel.
    2. Stack base predictions into a (1, 4) row.
    3. Push through the meta-Ridge.
    4. Bands from meta residual std × z=1.2816.

The whole flow is wrapped aggressively in try/except — if XGBoost is
missing, if the OOF stage fails, if the meta produces a blow-up, etc.,
we silently fall back to an equal-weight blend of whatever base learners
are still standing. Same public interface as `nowcast.backtest_nowcast`
and `nowcast.run_nowcast`.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.linear_model import ElasticNetCV, RidgeCV
from sklearn.model_selection import TimeSeriesSplit
from sklearn.preprocessing import StandardScaler

from .api_client import get_daily_panel
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, _build_supervised, DEFAULT_AS_OF_DAY
from .nowcast_features import build_daily_frame, features_at


# Number of TimeSeriesSplit folds. 5 keeps OOF rows high enough that the
# meta-Ridge sees ~120-150 rows on a 24-month-train panel — well above the
# champion_v3 "tiny OOF" overfit threshold of ~20.
_N_FOLDS = 5
# Z-score for 80% one-sided band.
_Z80 = 1.2816
# Sanity cap on absolute predicted MoM (%); above this we revert to fallback.
_MOM_SANITY_CAP = 5.0


# ---------------------------------------------------------------------------
# helpers: optional XGBoost import and base-learner factory
# ---------------------------------------------------------------------------

try:  # XGBoost is listed as an existing dep, but guard anyway.
    from xgboost import XGBRegressor

    _HAS_XGB = True
except Exception:  # pragma: no cover
    XGBRegressor = None  # type: ignore[assignment]
    _HAS_XGB = False


def _make_ridge() -> RidgeCV:
    return RidgeCV(alphas=np.logspace(-3, 3, 25))


def _make_gbr() -> GradientBoostingRegressor:
    return GradientBoostingRegressor(
        loss="quantile", alpha=0.5, n_estimators=300,
        max_depth=3, learning_rate=0.05, random_state=42,
    )


def _make_xgb():
    if not _HAS_XGB:
        return None
    return XGBRegressor(
        n_estimators=400,
        max_depth=3,
        learning_rate=0.05,
        subsample=0.85,
        colsample_bytree=0.85,
        min_child_weight=2,
        random_state=42,
        n_jobs=1,
        verbosity=0,
        objective="reg:squarederror",
    )


def _make_enet() -> ElasticNetCV:
    return ElasticNetCV(
        l1_ratio=[0.1, 0.3, 0.5, 0.7, 0.9],
        alphas=np.logspace(-3, 1, 20),
        max_iter=20000,
        random_state=42,
    )


# ---------------------------------------------------------------------------
# data classes
# ---------------------------------------------------------------------------


@dataclass
class StackedNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int


@dataclass
class _StackedModel:
    """Bundle of fitted base learners + meta. Used only inside this module.

    Some base slots may be None when their fit failed; the predict method
    handles missing columns by reusing the equal-weight average.
    """
    scaler: StandardScaler
    ridge: object | None
    gbr: object | None
    xgb: object | None
    enet: object | None
    meta: object | None  # RidgeCV trained on OOF
    feature_cols: list[str]
    base_names: list[str]    # ordered names of bases ACTUALLY used by meta
    resid_std: float
    used_meta: bool          # False -> fell back to equal weight

    def predict_one(self, x: pd.Series) -> tuple[float, float, float]:
        x_aligned = x.reindex(self.feature_cols).fillna(0.0).values.reshape(1, -1)
        x_s = self.scaler.transform(x_aligned)
        base_preds: dict[str, float] = {}
        if self.ridge is not None:
            try:
                base_preds["ridge"] = float(self.ridge.predict(x_s)[0])
            except Exception:
                pass
        if self.gbr is not None:
            try:
                base_preds["gbr"] = float(self.gbr.predict(x_aligned)[0])
            except Exception:
                pass
        if self.xgb is not None:
            try:
                base_preds["xgb"] = float(self.xgb.predict(x_aligned)[0])
            except Exception:
                pass
        if self.enet is not None:
            try:
                base_preds["enet"] = float(self.enet.predict(x_s)[0])
            except Exception:
                pass

        if self.used_meta and self.meta is not None and self.base_names:
            try:
                row = np.array(
                    [[base_preds[n] for n in self.base_names]], dtype=float
                )
                mean = float(self.meta.predict(row)[0])
            except Exception:
                # Meta blew up at inference — equal-weight whatever we have.
                vals = list(base_preds.values())
                mean = float(np.mean(vals)) if vals else 0.0
        else:
            vals = list(base_preds.values())
            mean = float(np.mean(vals)) if vals else 0.0

        # Sanity check — if mean is wild, clip to a saner fallback.
        if not np.isfinite(mean) or abs(mean) > _MOM_SANITY_CAP:
            vals = list(base_preds.values())
            mean = float(np.mean(vals)) if vals else 0.0
            if not np.isfinite(mean):
                mean = 0.0
        return mean, mean - _Z80 * self.resid_std, mean + _Z80 * self.resid_std


# ---------------------------------------------------------------------------
# core: fit a stacked model on a panel
# ---------------------------------------------------------------------------


def _safe_fit_predict(model_factory, X_fit, y_fit, X_pred):
    """Fit `model_factory()` on (X_fit, y_fit), predict on X_pred.

    Returns (model, preds) on success, (None, NaN-array) on any failure.
    """
    try:
        model = model_factory()
        if model is None:
            return None, np.full(len(X_pred), np.nan)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            model.fit(X_fit, y_fit)
            preds = np.asarray(model.predict(X_pred), dtype=float)
        if preds.shape[0] != X_pred.shape[0] or not np.all(np.isfinite(preds)):
            # XGBoost/ENet can in theory emit NaN under degenerate inputs.
            return None, np.full(len(X_pred), np.nan)
        return model, preds
    except Exception:
        return None, np.full(len(X_pred), np.nan)


def _fit_stacked_model(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int,
) -> _StackedModel:
    """Fit base learners + meta. Falls back to equal-weight on any error."""

    X_df, y_ser = _build_supervised(panel, daily_frame, as_of_day=as_of_day)
    feature_cols = list(X_df.columns)
    X_arr = X_df.values
    y_arr = y_ser.values
    n = len(y_arr)

    scaler = StandardScaler().fit(X_arr)
    X_s = scaler.transform(X_arr)

    # ----- Stage 1: OOF predictions via TimeSeriesSplit ---------------------
    used_meta = False
    meta_model: object | None = None
    base_names_used: list[str] = []
    resid_std = 0.30  # safe default, overwritten below if we have residuals

    # Need enough rows for 5 folds + a meaningful first training block.
    min_for_stack = max(30, _N_FOLDS * 4)
    if n >= min_for_stack:
        try:
            tss = TimeSeriesSplit(n_splits=_N_FOLDS)
            oof_ridge = np.full(n, np.nan)
            oof_gbr = np.full(n, np.nan)
            oof_xgb = np.full(n, np.nan)
            oof_enet = np.full(n, np.nan)

            for tr_idx, va_idx in tss.split(X_arr):
                X_tr_raw = X_arr[tr_idx]
                X_va_raw = X_arr[va_idx]
                X_tr_s = X_s[tr_idx]
                X_va_s = X_s[va_idx]
                y_tr = y_arr[tr_idx]

                _, p_ridge = _safe_fit_predict(_make_ridge, X_tr_s, y_tr, X_va_s)
                _, p_gbr = _safe_fit_predict(_make_gbr, X_tr_raw, y_tr, X_va_raw)
                _, p_xgb = _safe_fit_predict(_make_xgb, X_tr_raw, y_tr, X_va_raw)
                _, p_enet = _safe_fit_predict(_make_enet, X_tr_s, y_tr, X_va_s)

                oof_ridge[va_idx] = p_ridge
                oof_gbr[va_idx] = p_gbr
                oof_xgb[va_idx] = p_xgb
                oof_enet[va_idx] = p_enet

            oof_cols: dict[str, np.ndarray] = {
                "ridge": oof_ridge,
                "gbr": oof_gbr,
                "xgb": oof_xgb,
                "enet": oof_enet,
            }
            # Drop any base whose OOF column is all-NaN (e.g. xgb missing).
            usable = {
                name: arr for name, arr in oof_cols.items()
                if np.any(np.isfinite(arr))
            }
            if len(usable) >= 2:
                # Build OOF matrix with rows where ALL usable bases AND y are
                # finite — otherwise meta_X has NaN and Ridge errors.
                names = list(usable.keys())
                stacked = np.column_stack([usable[n] for n in names])
                mask = np.all(np.isfinite(stacked), axis=1) & np.isfinite(y_arr)
                meta_X = stacked[mask]
                meta_y = y_arr[mask]
                # Need at least k+2 rows (k=#bases) for a sensible Ridge fit.
                # We're aggressive about this — champion_v3 burned us with
                # tiny OOF sets blessing wild meta coefs.
                if len(meta_y) >= max(20, len(names) + 6):
                    try:
                        meta = RidgeCV(alphas=np.logspace(-2, 2, 13)).fit(meta_X, meta_y)
                        meta_pred = meta.predict(meta_X)
                        residuals = meta_y - meta_pred
                        rs = float(np.std(residuals))
                        if np.isfinite(rs) and rs > 0:
                            resid_std = rs
                            meta_model = meta
                            base_names_used = names
                            used_meta = True
                    except Exception:
                        used_meta = False
        except Exception:
            used_meta = False

    # ----- Stage 2: refit each base on FULL training set --------------------
    final_ridge, _ = _safe_fit_predict(_make_ridge, X_s, y_arr, X_s)
    final_gbr, _ = _safe_fit_predict(_make_gbr, X_arr, y_arr, X_arr)
    final_xgb, _ = _safe_fit_predict(_make_xgb, X_arr, y_arr, X_arr)
    final_enet, _ = _safe_fit_predict(_make_enet, X_s, y_arr, X_s)

    # Drop bases the meta didn't see — predict_one will only use base_names_used.
    if used_meta:
        kept = set(base_names_used)
        if "ridge" not in kept:
            final_ridge = None
        if "gbr" not in kept:
            final_gbr = None
        if "xgb" not in kept:
            final_xgb = None
        if "enet" not in kept:
            final_enet = None

    # If meta failed, compute fallback residual std from in-sample equal-weight.
    if not used_meta:
        in_sample_preds: list[np.ndarray] = []
        if final_ridge is not None:
            try:
                in_sample_preds.append(final_ridge.predict(X_s))
            except Exception:
                pass
        if final_gbr is not None:
            try:
                in_sample_preds.append(final_gbr.predict(X_arr))
            except Exception:
                pass
        if final_xgb is not None:
            try:
                in_sample_preds.append(final_xgb.predict(X_arr))
            except Exception:
                pass
        if final_enet is not None:
            try:
                in_sample_preds.append(final_enet.predict(X_s))
            except Exception:
                pass
        if in_sample_preds:
            blend = np.mean(in_sample_preds, axis=0)
            rs = float(np.std(y_arr - blend))
            if np.isfinite(rs) and rs > 0:
                resid_std = rs

    return _StackedModel(
        scaler=scaler,
        ridge=final_ridge,
        gbr=final_gbr,
        xgb=final_xgb,
        enet=final_enet,
        meta=meta_model,
        feature_cols=feature_cols,
        base_names=base_names_used,
        resid_std=resid_std,
        used_meta=used_meta,
    )


# ---------------------------------------------------------------------------
# inference helpers (mirror nowcast.run_nowcast / nowcast.backtest_nowcast)
# ---------------------------------------------------------------------------


def _build_inference_features(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    target_month_end: pd.Timestamp,
    as_of: pd.Timestamp,
) -> pd.Series:
    """Mirror nowcast.run_nowcast's feature construction for one cut."""
    feats = features_at(daily_frame, as_of)
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
    feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    feats["cpi_mom_lag2"] = float(y_mom.iloc[-2]) if len(y_mom) >= 2 else 0.0
    if len(cpi) >= 13:
        feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    else:
        feats["cpi_yoy_lag1"] = 0.0
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    return pd.Series(feats)


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------


def backtest_stacked_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest of the STACKED nowcaster.

    Same shape as `nowcast.backtest_nowcast`, so it can be slotted in.
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
        target_month_end = y_mom.index[ci]
        train_panel = panel.loc[panel.index < target_month_end]
        if len(train_panel) < 60:
            continue

        try:
            model = _fit_stacked_model(train_panel, daily_frame, as_of_day=as_of_day)
        except Exception:
            continue

        m_start = target_month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        try:
            feats = features_at(daily_frame, as_of)
        except Exception:
            continue

        train_y = build_target(train_panel).dropna()
        if len(train_y) < 13:
            continue
        feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
        feats["cpi_mom_lag2"] = float(train_y.iloc[-2])
        try:
            feats["cpi_yoy_lag1"] = float(
                (train_panel[TARGET.fred_id].dropna().iloc[-1]
                 / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0) * 100.0
            )
        except Exception:
            feats["cpi_yoy_lag1"] = 0.0
        feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

        try:
            pred_mom, _, _ = model.predict_one(pd.Series(feats))
        except Exception:
            continue
        actual_mom = float(y_mom.iloc[ci])

        last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
        pred_cpi = last_cpi_train * float(np.exp(pred_mom / 100.0))
        denom_idx = target_month_end - pd.DateOffset(years=1)
        denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
        try:
            denom = float(cpi.loc[denom_idx])
        except KeyError:
            denom = float(cpi.asof(denom_idx))
        pred_yoy = (pred_cpi / denom - 1.0) * 100.0
        actual_cpi = float(cpi.loc[target_month_end])
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
            "used_meta": bool(model.used_meta),
        })

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


def run_stacked_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> StackedNowcastResult:
    """Top-level: fetch panels, train stacked model, produce current-month forecast."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    model = _fit_stacked_model(panel, daily_frame, as_of_day=as_of_day)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    feats = _build_inference_features(panel, daily_frame, target_month_end, as_of)
    pred_mom, lo, hi = model.predict_one(feats)

    last_cpi = float(cpi.iloc[-1])
    predicted_cpi = last_cpi * float(np.exp(pred_mom / 100.0))
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    pred_yoy = (predicted_cpi / denom - 1.0) * 100.0

    pred_cpi_lo = last_cpi * float(np.exp(lo / 100.0))
    pred_cpi_hi = last_cpi * float(np.exp(hi / 100.0))
    lo80_yoy = (pred_cpi_lo / denom - 1.0) * 100.0
    hi80_yoy = (pred_cpi_hi / denom - 1.0) * 100.0

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )

    return StackedNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
    )
