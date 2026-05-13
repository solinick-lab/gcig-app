"""Multi-target joint forecast nowcaster.

Standard nowcaster predicts only the current month (h=0). Here we train a
model that JOINTLY predicts {h=0, h=+1, h=+2} MoM via sklearn's RegressorChain
or MultiOutputRegressor. Joint training shares signal across horizons — the
intuition is that the same features (oil prices, inflation expectations, etc.)
drive correlated near-term inflation outcomes, so multi-task supervision
regularizes the h=0 head.

The deliverable focuses on h=0 metrics (matches the baseline interface in
nowcast.backtest_nowcast), but training uses 3-target supervision.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

try:
    from sklearn.ensemble import GradientBoostingRegressor
    from sklearn.linear_model import Ridge
    from sklearn.multioutput import MultiOutputRegressor, RegressorChain
    from sklearn.preprocessing import StandardScaler
except Exception:  # pragma: no cover - sklearn is required, but keep import-safe
    GradientBoostingRegressor = None  # type: ignore
    Ridge = None  # type: ignore
    MultiOutputRegressor = None  # type: ignore
    RegressorChain = None  # type: ignore
    StandardScaler = None  # type: ignore

try:
    from xgboost import XGBRegressor
except Exception:  # pragma: no cover
    XGBRegressor = None  # type: ignore

from .api_client import get_daily_panel
from .features import build_target
from .fred import TARGET, fetch_panel
from .nowcast import _as_of_for_month, _build_supervised
from .nowcast_features import build_daily_frame, features_at


DEFAULT_AS_OF_DAY = 20
N_HORIZONS = 3  # h=0, h=+1, h=+2


def _build_multitarget(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int,
) -> tuple[pd.DataFrame, np.ndarray]:
    """Build (X, Y) where Y[t] = [y[t], y[t+1], y[t+2]] (future MoMs).

    Drops rows where any of the future targets are unavailable.
    """
    X, y = _build_supervised(panel, daily_frame, as_of_day=as_of_day)
    y_mom = build_target(panel).dropna()

    # Build aligned multi-target matrix indexed by month_end of h=0.
    rows_x: list[pd.Series] = []
    targets: list[list[float]] = []
    for month_end in X.index:
        try:
            pos = y_mom.index.get_loc(month_end)
        except KeyError:
            continue
        if pos + N_HORIZONS - 1 >= len(y_mom):
            continue
        ys = [float(y_mom.iloc[pos + h]) for h in range(N_HORIZONS)]
        if any(np.isnan(v) for v in ys):
            continue
        rows_x.append(X.loc[month_end])
        targets.append(ys)

    if not rows_x:
        raise RuntimeError("no rows with full multi-horizon targets")

    X_df = pd.DataFrame(rows_x)
    Y = np.asarray(targets, dtype=float)
    return X_df, Y


def _internal_cv_score(model_factory, X: np.ndarray, Y: np.ndarray, n_splits: int = 4) -> float:
    """Cheap rolling-origin CV on h=0 RMSE. Lower is better."""
    n = len(X)
    if n < n_splits + 4:
        return float("inf")
    fold_size = max(2, n // (n_splits + 1))
    errs: list[float] = []
    for k in range(1, n_splits + 1):
        cut = n - k * fold_size
        if cut < 8:
            break
        try:
            m = model_factory()
            m.fit(X[:cut], Y[:cut])
            pred = m.predict(X[cut:cut + fold_size])
            pred_h0 = pred[:, 0] if pred.ndim == 2 else pred
            actual_h0 = Y[cut:cut + fold_size, 0]
            errs.append(float(np.sqrt(np.mean((pred_h0 - actual_h0) ** 2))))
        except Exception:
            continue
    return float(np.mean(errs)) if errs else float("inf")


def _fit_multitarget_model(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    as_of_day: int,
) -> dict:
    """Fit RegressorChain(Ridge) + RegressorChain(XGB) ensemble; pick on internal CV.

    Also tries MultiOutputRegressor(GBR) as an alternative; we pick whichever
    candidate scores best on internal walk-forward CV for h=0.
    """
    X_df, Y = _build_multitarget(panel, daily_frame, as_of_day=as_of_day)
    cols = list(X_df.columns)
    X = X_df.values.astype(float)

    scaler = StandardScaler().fit(X)
    Xs = scaler.transform(X)

    # Candidate 1: RegressorChain(Ridge)
    def _ridge_chain():
        return RegressorChain(Ridge(alpha=1.0), order=list(range(N_HORIZONS)))

    # Candidate 2: RegressorChain(XGB)  (skip if xgboost not available)
    def _xgb_chain():
        if XGBRegressor is None:
            raise RuntimeError("xgboost not available")
        base = XGBRegressor(
            n_estimators=200, max_depth=3, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8, random_state=42,
            verbosity=0, n_jobs=1,
        )
        return RegressorChain(base, order=list(range(N_HORIZONS)))

    # Candidate 3: MultiOutputRegressor(GBR)
    def _gbr_multi():
        return MultiOutputRegressor(GradientBoostingRegressor(
            n_estimators=200, max_depth=3, learning_rate=0.05, random_state=42,
        ))

    # Score each on internal CV for h=0.
    cv_ridge = _internal_cv_score(lambda: _ridge_chain(), Xs, Y)
    cv_xgb = _internal_cv_score(lambda: _xgb_chain(), X, Y) if XGBRegressor is not None else float("inf")
    cv_gbr = _internal_cv_score(lambda: _gbr_multi(), X, Y)

    # Always fit ridge_chain (cheap) + the better of {xgb, gbr} for ensemble.
    ridge_chain = _ridge_chain().fit(Xs, Y)
    tree_label, tree_model, tree_uses_scaled = "gbr", _gbr_multi().fit(X, Y), False
    if XGBRegressor is not None and cv_xgb < cv_gbr:
        try:
            tree_model = _xgb_chain().fit(X, Y)
            tree_label = "xgb_chain"
        except Exception:
            tree_model = _gbr_multi().fit(X, Y)
            tree_label = "gbr"

    # In-sample h=0 residual std for 80% bands.
    pred_ridge = ridge_chain.predict(Xs)
    pred_tree = tree_model.predict(Xs if tree_uses_scaled else X)
    blend_h0 = 0.5 * pred_ridge[:, 0] + 0.5 * pred_tree[:, 0]
    resid = Y[:, 0] - blend_h0
    resid_std = float(np.std(resid))

    return {
        "scaler": scaler,
        "ridge_chain": ridge_chain,
        "tree_model": tree_model,
        "tree_label": tree_label,
        "feature_cols": cols,
        "resid_std": resid_std,
        "cv_scores": {"ridge": cv_ridge, "xgb": cv_xgb, "gbr": cv_gbr},
        "as_of_day": as_of_day,
    }


def _predict_one(model: dict, x: pd.Series) -> tuple[float, float, float]:
    """Return (mean h=0, lo80, hi80) for a single feature row."""
    cols = model["feature_cols"]
    x_aligned = x.reindex(cols).fillna(0.0).values.reshape(1, -1).astype(float)
    Xs = model["scaler"].transform(x_aligned)
    pred_ridge = model["ridge_chain"].predict(Xs)[0]
    pred_tree = model["tree_model"].predict(x_aligned)[0]
    mean_h0 = 0.5 * float(pred_ridge[0]) + 0.5 * float(pred_tree[0])
    z = 1.2816  # 80%
    sd = model["resid_std"]
    return mean_h0, mean_h0 - z * sd, mean_h0 + z * sd


def backtest_multitarget_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    """Walk-forward backtest. Each cut: train multi-target model on data <t,
    predict h=0 (current month MoM) and convert to YoY. Returns h=0 metrics."""
    try:
        cpi = panel[TARGET.fred_id].dropna()
        y_mom = build_target(panel).dropna()

        cuts = list(range(len(y_mom) - window_months, len(y_mom)))
        preds_mom: list[float] = []
        actuals_mom: list[float] = []
        preds_yoy: list[float] = []
        actuals_yoy: list[float] = []
        rows: list[dict] = []
        cv_log: dict | None = None

        for ci in cuts:
            target_month_end = y_mom.index[ci]
            train_panel = panel.loc[panel.index < target_month_end]
            if len(train_panel) < 60:
                continue
            try:
                model = _fit_multitarget_model(train_panel, daily_frame, as_of_day=as_of_day)
                cv_log = model["cv_scores"]
            except Exception:
                continue

            m_start = target_month_end + pd.offsets.MonthBegin(-1)
            as_of = _as_of_for_month(m_start, as_of_day)
            feats = features_at(daily_frame, as_of)
            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue
            feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
            feats["cpi_mom_lag2"] = float(train_y.iloc[-2])
            feats["cpi_yoy_lag1"] = float(
                (train_panel[TARGET.fred_id].dropna().iloc[-1]
                 / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0) * 100.0
            )
            feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
            feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

            try:
                pred_mom, _, _ = _predict_one(model, pd.Series(feats))
            except Exception:
                continue
            actual_mom = float(y_mom.iloc[ci])

            # YoY conversion (same logic as nowcast.backtest_nowcast).
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
            })

        if not preds_mom:
            return {"error": "no successful cuts"}

        pm = np.array(preds_mom); am = np.array(actuals_mom)
        py = np.array(preds_yoy); ay = np.array(actuals_yoy)
        yoy_err = np.abs(py - ay)
        out = {
            "asOfDay": as_of_day,
            "windowMonths": window_months,
            "totalCuts": len(preds_mom),
            "rmseMom": float(np.sqrt(np.mean((pm - am) ** 2))),
            "rmseYoy": float(np.sqrt(np.mean((py - ay) ** 2))),
            "maeYoy": float(np.mean(yoy_err)),
            "hitWithin25bp": float((yoy_err <= 0.25).mean()) * 100,
            "hitWithin50bp": float((yoy_err <= 0.50).mean()) * 100,
            "rows": rows,
            "approach": "multi-target joint forecast (h=0,1,2)",
        }
        if cv_log is not None:
            out["lastInternalCv"] = {k: (None if not np.isfinite(v) else round(v, 4)) for k, v in cv_log.items()}
        return out
    except Exception as e:
        return {"error": f"multitarget backtest failed: {type(e).__name__}: {e}"}


def run_multitarget_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> dict:
    """Top-level: fetch panels, train multi-target, produce a current-month
    nowcast (h=0) plus h=+1, h=+2 forward forecasts as bonus output."""
    try:
        panel = fetch_panel()
        daily_panel = get_daily_panel()
        daily_frame = build_daily_frame(daily_panel)

        model = _fit_multitarget_model(panel, daily_frame, as_of_day=as_of_day)

        today = pd.Timestamp.utcnow().tz_localize(None).normalize()
        cpi = panel[TARGET.fred_id].dropna()
        last_released_month_end = cpi.index[-1]
        target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
        target_month_start = target_month_end + pd.offsets.MonthBegin(-1)

        as_of = min(today, target_month_end)
        if today < target_month_start:
            as_of = _as_of_for_month(target_month_start, as_of_day)

        feats = features_at(daily_frame, as_of)
        y_mom = build_target(panel).dropna()
        feats["cpi_mom_lag1"] = float(y_mom.iloc[-1])
        feats["cpi_mom_lag2"] = float(y_mom.iloc[-2])
        feats["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
        feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
        feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))

        # Get full 3-horizon prediction so we can also report h=+1, h=+2.
        cols = model["feature_cols"]
        x_aligned = pd.Series(feats).reindex(cols).fillna(0.0).values.reshape(1, -1).astype(float)
        Xs = model["scaler"].transform(x_aligned)
        pred_ridge = model["ridge_chain"].predict(Xs)[0]
        pred_tree = model["tree_model"].predict(x_aligned)[0]
        pred_full = 0.5 * pred_ridge + 0.5 * pred_tree

        pred_mom = float(pred_full[0])
        z = 1.2816
        sd = model["resid_std"]
        lo, hi = pred_mom - z * sd, pred_mom + z * sd

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

        return {
            "as_of": as_of.strftime("%Y-%m-%d"),
            "target_month": target_month_end.strftime("%Y-%m"),
            "pred_mom": pred_mom,
            "pred_yoy": pred_yoy,
            "lo80_yoy": lo80_yoy,
            "hi80_yoy": hi80_yoy,
            "days_observed": days_observed,
            "future_mom_h1": float(pred_full[1]) if len(pred_full) > 1 else None,
            "future_mom_h2": float(pred_full[2]) if len(pred_full) > 2 else None,
            "tree_model_choice": model["tree_label"],
            "internal_cv": {k: (None if not np.isfinite(v) else round(v, 4)) for k, v in model["cv_scores"].items()},
        }
    except Exception as e:
        return {"error": f"multitarget run failed: {type(e).__name__}: {e}"}
