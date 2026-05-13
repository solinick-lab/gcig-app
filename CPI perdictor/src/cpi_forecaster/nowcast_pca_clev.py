"""PCA-pre-reduced Cleveland-feature nowcaster.

Yellen 1.1 (`nowcast_clev_calibrated.py`, MAE 0.1142) builds a wide
feature matrix with ~50+ columns: rich daily/macro features
(`rich_features_at`) + CPI lags / calendar + Cleveland Fed nowcast
features. Many of those daily/macro columns are highly co-moving (oil,
FX, equities, treasuries), so the GBR sees a noisy correlated subspace.

Hypothesis: keep the Cleveland nowcast features and CPI lags as direct
passthrough signal (they carry near-linear, low-collinearity info) and
compress only the daily/macro block to ~10 latent factors. That should
strip overfit-prone correlated noise while preserving the strongest
signal columns.

Pipeline:
    daily/macro_X --> StandardScaler --> PCA(10) ----|
                                                     |--> [PCA(10) | clev | lags | calendar] --> q={0.1, 0.5, 0.9} GBR
    clev_X + lag_X + calendar_X ---------------------|

Sort the (q0.1, q0.5, q0.9) triple per-prediction to enforce
monotonicity. Clip MoM to [-1.5, 2.5]. Each cut wrapped in try/except
so a single bad fit doesn't poison the walk-forward window.

Public API:
  backtest_pca_clev_nowcast(panel, daily_frame, window_months=24, as_of_day=20) -> dict
  run_pca_clev_nowcast(as_of_day=20) -> PcaClevNowcastResult
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.decomposition import PCA
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.preprocessing import StandardScaler

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

_QUANTILES = (0.1, 0.5, 0.9)
_PCA_COMPONENTS = 10

# Columns that bypass PCA — strong direct signal that PCA would dilute.
# Cleveland nowcast features + CPI lags + calendar.
_PASSTHROUGH_COLS = (
    # CPI lags + calendar
    "cpi_mom_lag1",
    "cpi_mom_lag2",
    "cpi_yoy_lag1",
    "month_sin",
    "month_cos",
    # Cleveland Fed nowcast block (matches _clev_features_for_month)
    "clev_yoy",
    "clev_mom",
    "clev_core_yoy",
    "clev_core_mom",
    "clev_next_yoy",
    "clev_next_mom",
    "clev_used_scrape",
    "clev_yoy_minus_lag",
)

_GBR_PARAMS = dict(
    n_estimators=400,
    max_depth=3,
    learning_rate=0.05,
    random_state=42,
)


@dataclass
class PcaClevNowcastResult:
    as_of: pd.Timestamp
    target_month: str
    pred_mom: float
    pred_yoy: float
    lo80_yoy: float
    hi80_yoy: float
    days_observed: int
    used_clev_scrape: bool


@dataclass
class PcaClevNowcastModel:
    scaler: StandardScaler
    pca: PCA
    models: dict[float, GradientBoostingRegressor]
    daily_cols: list[str]      # cols pushed through PCA
    passthrough_cols: list[str]  # cols concatenated post-PCA
    median_fill: pd.Series
    as_of_day: int

    def _transform(self, x: pd.Series) -> np.ndarray:
        """Build the [PCA(daily) | passthrough] inference vector."""
        # Median-fill missing values consistent with training
        x_filled = x.copy()
        for c in list(self.daily_cols) + list(self.passthrough_cols):
            v = x_filled.get(c, np.nan)
            if not np.isfinite(v):
                x_filled[c] = float(self.median_fill.get(c, 0.0)) if c in self.median_fill.index else 0.0

        daily_vals = (
            x_filled.reindex(self.daily_cols).fillna(0.0).values.reshape(1, -1).astype(float)
        )
        passthrough_vals = (
            x_filled.reindex(self.passthrough_cols).fillna(0.0).values.reshape(1, -1).astype(float)
            if self.passthrough_cols else np.empty((1, 0))
        )
        daily_s = self.scaler.transform(daily_vals)
        daily_pcs = self.pca.transform(daily_s)
        return np.hstack([daily_pcs, passthrough_vals])

    def predict_one(self, x: pd.Series) -> tuple[float, float, float]:
        """Return (median_pred, lo10, hi90) — sorted for monotonicity."""
        z = self._transform(x)
        preds = [float(self.models[q].predict(z)[0]) for q in _QUANTILES]
        triple = np.sort(np.array(preds, dtype=float))
        return float(triple[1]), float(triple[0]), float(triple[2])


def _split_daily_passthrough(X: pd.DataFrame) -> tuple[list[str], list[str]]:
    """Partition columns into (daily, passthrough). Anything not in the
    explicit passthrough list goes into the PCA block."""
    passthrough = [c for c in _PASSTHROUGH_COLS if c in X.columns]
    daily = [c for c in X.columns if c not in passthrough]
    return daily, passthrough


def fit_pca_clev_nowcast_model(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    clev: dict,
    as_of_day: int = DEFAULT_AS_OF_DAY,
    n_components: int = _PCA_COMPONENTS,
) -> PcaClevNowcastModel:
    """StandardScaler -> PCA(daily block) -> concat clev/lags -> 3 quantile GBRs."""
    X, y = _build_supervised_clev(panel, daily_frame, clev, as_of_day=as_of_day)
    daily_cols, passthrough_cols = _split_daily_passthrough(X)

    daily_block = X[daily_cols].values.astype(float) if daily_cols else np.empty((len(X), 0))
    passthrough_block = (
        X[passthrough_cols].values.astype(float)
        if passthrough_cols else np.empty((len(X), 0))
    )

    if daily_block.shape[1] > 0:
        scaler = StandardScaler().fit(daily_block)
        daily_s = scaler.transform(daily_block)
        n_comp = min(n_components, daily_s.shape[1], max(1, daily_s.shape[0] - 1))
        pca = PCA(n_components=n_comp, random_state=42).fit(daily_s)
        daily_pcs = pca.transform(daily_s)
    else:
        scaler = StandardScaler().fit(np.zeros((len(X), 1)))
        pca = PCA(n_components=1, random_state=42).fit(np.zeros((len(X), 1)))
        daily_pcs = np.empty((len(X), 0))

    Z = np.hstack([daily_pcs, passthrough_block])
    yv = y.values

    models: dict[float, GradientBoostingRegressor] = {}
    for q in _QUANTILES:
        gbr = GradientBoostingRegressor(
            loss="quantile", alpha=q, **_GBR_PARAMS,
        ).fit(Z, yv)
        models[q] = gbr

    median_fill = X.median(numeric_only=True)

    return PcaClevNowcastModel(
        scaler=scaler,
        pca=pca,
        models=models,
        daily_cols=daily_cols,
        passthrough_cols=passthrough_cols,
        median_fill=median_fill,
        as_of_day=as_of_day,
    )


def _build_inference_feats(
    train_panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    target_month_end: pd.Timestamp,
    clev: dict,
    panel_for_clev: pd.DataFrame,
    as_of_day: int,
) -> tuple[dict[str, float], pd.Timestamp]:
    """Inference-time feature row matching what _build_supervised_clev produces."""
    m_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = _as_of_for_month(m_start, as_of_day)
    feats = rich_features_at(daily_frame, as_of)
    train_y = build_target(train_panel).dropna()
    cpi_train = train_panel[TARGET.fred_id].dropna()
    feats["cpi_mom_lag1"] = float(train_y.iloc[-1])
    feats["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else np.nan
    feats["cpi_yoy_lag1"] = float(
        (cpi_train.iloc[-1] / cpi_train.iloc[-13] - 1.0) * 100.0
    )
    feats["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    feats["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    try:
        feats.update(_clev_features_for_month(clev, target_month_end, panel_for_clev))
    except Exception:
        pass
    return feats, as_of


def backtest_pca_clev_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict[str, pd.Series],
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
    n_components: int = _PCA_COMPONENTS,
) -> dict:
    """Walk-forward backtest: PCA(daily) + passthrough(clev/lags) + 3 quantile GBRs."""
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

            model = fit_pca_clev_nowcast_model(
                train_panel, daily_frame, clev,
                as_of_day=as_of_day, n_components=n_components,
            )

            train_y = build_target(train_panel).dropna()
            if len(train_y) < 13:
                continue

            feats, as_of = _build_inference_feats(
                train_panel, daily_frame, target_month_end, clev, panel, as_of_day,
            )

            pred_mom, _, _ = model.predict_one(pd.Series(feats))
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


def run_pca_clev_nowcast(
    as_of_day: int = DEFAULT_AS_OF_DAY,
    n_components: int = _PCA_COMPONENTS,
) -> PcaClevNowcastResult:
    """Live nowcast using the PCA-pre-reduced Cleveland-feature stack."""
    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)
    clev = _safe_get_clev()
    used_scrape = bool(clev.get("ok"))

    model = fit_pca_clev_nowcast_model(
        panel, daily_frame, clev,
        as_of_day=as_of_day, n_components=n_components,
    )

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
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
        feats.update(_clev_features_for_month(clev, target_month_end, panel))
    except Exception:
        pass

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
    return PcaClevNowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=pred_mom,
        pred_yoy=pred_yoy,
        lo80_yoy=lo80_yoy,
        hi80_yoy=hi80_yoy,
        days_observed=days_observed,
        used_clev_scrape=used_scrape,
    )
