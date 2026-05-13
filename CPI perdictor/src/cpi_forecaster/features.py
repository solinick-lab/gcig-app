"""Feature engineering.

Turns the wide FRED panel into a feature matrix suitable for the Ridge
and XGBoost models. The SARIMA model uses raw CPI directly and ignores
this module.

Conventions:
  - Target is MoM log-difference of CPIAUCSL (stationary, easy to chain).
  - Features are lagged so a row for month T only uses information that
    would have been available by month T (no leakage).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from .fred import FEATURES, TARGET

_WARNED_MISSING: set[str] = set()


def _yoy(s: pd.Series) -> pd.Series:
    return (s / s.shift(12) - 1.0) * 100.0


def _mom(s: pd.Series) -> pd.Series:
    return (s / s.shift(1) - 1.0) * 100.0


def _log_mom(s: pd.Series) -> pd.Series:
    """Log MoM change in percent. Approx equal to _mom for small changes,
    but better-behaved for chaining and modeling."""
    return (np.log(s) - np.log(s.shift(1))) * 100.0


def build_target(panel: pd.DataFrame) -> pd.Series:
    """The target the models predict: MoM % change in CPI (log space)."""
    cpi = panel[TARGET.fred_id]
    return _log_mom(cpi).rename("y_mom_pct")


def build_features(panel: pd.DataFrame) -> pd.DataFrame:
    """Lagged feature matrix aligned to predict the next month."""
    rows: dict[str, pd.Series] = {}

    cpi = panel[TARGET.fred_id]
    rows["cpi_mom_lag1"] = _log_mom(cpi).shift(1)
    rows["cpi_mom_lag2"] = _log_mom(cpi).shift(2)
    rows["cpi_mom_lag3"] = _log_mom(cpi).shift(3)
    rows["cpi_yoy_lag1"] = _yoy(cpi).shift(1)

    missing: list[str] = []
    for f in FEATURES:
        if f.fred_id not in panel.columns:
            missing.append(f.fred_id)
            continue
        col = panel[f.fred_id]
        # MoM % change, lag 1 (so it's information available by the time
        # we'd predict next month's CPI).
        rows[f"{f.fred_id}_mom_lag1"] = _mom(col).shift(1)
        # 3-month % change, lag 1. Smoother than 1-month; captures the
        # slow-moving pressure (rents, wages, broad commodities).
        rows[f"{f.fred_id}_3mo_lag1"] = ((col / col.shift(3) - 1.0) * 100.0).shift(1)
        # YoY % change, lag 1. Good for shelter, wages, expectations
        # which have strong seasonal patterns.
        rows[f"{f.fred_id}_yoy_lag1"] = _yoy(col).shift(1)
    new_missing = [m for m in missing if m not in _WARNED_MISSING]
    if new_missing:
        print(f"[features] panel missing {len(new_missing)} feature(s); skipping: {new_missing}")
        _WARNED_MISSING.update(new_missing)

    # Calendar features — capture residual seasonality the macro features miss.
    idx = panel.index
    rows["month_sin"] = pd.Series(
        np.sin(2 * np.pi * idx.month / 12.0), index=idx, name="month_sin"
    )
    rows["month_cos"] = pd.Series(
        np.cos(2 * np.pi * idx.month / 12.0), index=idx, name="month_cos"
    )

    feats = pd.concat(rows, axis=1)
    return feats


def build_supervised(panel: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    """Aligned (X, y) for the most recent point-in-time we can train on.

    Drops rows with any NaN in features OR target. y is MoM % at month T;
    X[T] uses information available at the end of month T-1.
    """
    y = build_target(panel)
    X = build_features(panel)
    df = X.join(y, how="inner").dropna()
    return df.drop(columns=["y_mom_pct"]), df["y_mom_pct"]
