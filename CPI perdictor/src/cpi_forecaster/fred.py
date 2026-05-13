"""Macro panel loader.

We don't talk to FRED directly — gcig-api proxies it for us so the
FRED_API_KEY never has to live on this machine. The server returns the
already-aligned monthly panel; we hand it to pandas.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from .api_client import get_fred_panel

CACHE_DIR = Path(os.environ.get("CPI_CACHE_DIR", ".cache"))
CACHE_TTL_SECONDS = 6 * 60 * 60  # 6h — server caches 12h, we double-cache for dev


@dataclass(frozen=True)
class Series:
    fred_id: str
    label: str


# Target — what we predict.
TARGET = Series("CPIAUCSL", "CPI All-Items SA")

# Subcomponents — used by the hierarchical forecaster, not by the
# default macro feature set. Aggregating component forecasts (Food,
# Energy, Core) typically beats forecasting headline directly.
SUBCOMPONENTS: tuple[Series, ...] = (
    Series("CPIUFDSL", "CPI Food SA"),
    Series("CPIENGSL", "CPI Energy SA"),
    Series("CPILFESL", "CPI Core (less food + energy) SA"),
)

# Features — the ORIGINAL 14 leading indicators. `build_features` iterates
# this tuple, so keeping it narrow is what the deployed RFF engine + most
# winning strategies were designed for. With ~250 monthly rows of training
# data, expanding this tuple to 37 features blew up downstream Ridge/XGBoost
# fits: the round-5 race showed 22 strategies crashed to fallback.
#
# The server-side fredPanel.js still fetches all 38 series and `panel`
# DataFrames have all 38 columns — strategies that explicitly want a new
# series (e.g. agent_ff_tips reading panel['T5YIE']) can still access them
# via EXTRA_SERIES below. They just don't bloat the default feature matrix.
FEATURES: tuple[Series, ...] = (
    Series("DCOILWTICO", "WTI Oil"),
    Series("GASREGW", "Retail Gas"),
    Series("PPIACO", "PPI All Commodities"),
    Series("PPIFIS", "PPI Final Demand"),
    Series("CSUSHPISA", "Case-Shiller Home Price"),
    Series("CUSR0000SAH1", "CPI Shelter"),
    Series("CES0500000003", "Avg Hourly Earnings"),
    Series("UNRATE", "Unemployment Rate"),
    Series("M2SL", "M2 Money Stock"),
    Series("DTWEXBGS", "USD Index Broad"),
    Series("DGS10", "10Y Treasury Yield"),
    Series("MICH", "Michigan 1Y Inflation Expectations"),
    Series("INDPRO", "Industrial Production"),
    Series("RSAFS", "Retail Sales"),
)

# Extra series fetched but NOT in the default feature matrix. Available
# in `panel.columns` for strategies that explicitly target them.
EXTRA_SERIES: tuple[Series, ...] = (
    # Inflation expectations (market + survey + Fed)
    Series("T5YIE", "5Y TIPS Breakeven"),
    Series("T10YIE", "10Y TIPS Breakeven"),
    Series("T5YIFR", "5Y Forward 5Y Inflation Expectations"),
    Series("MEDCPIM158SFRBCLE", "Cleveland Fed Median CPI"),
    Series("TRMMEANCPIM158SFRBCLE", "Cleveland Fed 16% Trimmed Mean CPI"),
    Series("STICKCPIM157SFRBATL", "Atlanta Fed Sticky CPI"),
    # Rates + policy
    Series("T10Y2Y", "10Y minus 2Y Yield Spread"),
    Series("T10Y3M", "10Y minus 3M Yield Spread"),
    Series("DGS2", "2Y Treasury"),
    Series("FEDFUNDS", "Fed Funds Rate"),
    Series("BAMLH0A0HYM2", "High-Yield Bond Spread"),
    # Labor
    Series("ICSA", "Initial Jobless Claims"),
    Series("JTSJOL", "JOLTS Job Openings"),
    Series("JTSQUL", "JOLTS Quits"),
    # Demand
    Series("UMCSENT", "U Michigan Consumer Sentiment"),
    Series("PCEPI", "PCE Price Index"),
    Series("PCEPILFE", "Core PCE Price Index"),
    # Housing
    Series("HOUST", "Housing Starts"),
    Series("PERMIT", "Building Permits"),
    # Activity
    Series("TCU", "Capacity Utilization"),
    # Energy + commodities
    Series("DCOILBRENTEU", "Brent Crude"),
    Series("GASDESW", "Diesel Retail"),
    Series("PPIIDC", "PPI Industrial Commodities"),
)


def _panel_from_response(resp: dict) -> pd.DataFrame:
    """Convert the gcig-api JSON shape to a wide DataFrame.

    Server payload:
        { fetchedAt, monthEnd: ["YYYY-MM-DD", ...], series: { ID: [..nullable..] } }
    Returns a DataFrame indexed by month-end Timestamps with one column per
    series. Missing observations come through as NaN (aligned by row).
    """
    month_end = resp.get("monthEnd") or []
    series = resp.get("series") or {}
    if not month_end or not series:
        raise RuntimeError("Empty panel from gcig-api")
    idx = pd.to_datetime(month_end)
    cols = {sid: pd.Series(values, index=idx, name=sid) for sid, values in series.items()}
    panel = pd.concat(cols, axis=1)
    panel.index.name = "month_end"
    panel.attrs["fetched_at"] = resp.get("fetchedAt") or datetime.now(timezone.utc).isoformat()
    return panel


def fetch_panel(force_refresh: bool = False) -> pd.DataFrame:
    """Get the macro panel via gcig-api, with a small local Parquet cache.

    The server caches for 12h; we cache for 6h locally so dev runs don't
    re-hit the API on every iteration. Cron runs naturally bypass the
    cache because each monthly run is far past the TTL.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = CACHE_DIR / "panel.parquet"

    if not force_refresh and cache_path.exists():
        if time.time() - cache_path.stat().st_mtime < CACHE_TTL_SECONDS:
            return pd.read_parquet(cache_path)

    resp = get_fred_panel()
    panel = _panel_from_response(resp)
    if TARGET.fred_id not in panel.columns:
        raise RuntimeError(
            f"Panel response is missing target series {TARGET.fred_id}. "
            "Check FRED_API_KEY on the gcig-api side."
        )
    panel.to_parquet(cache_path)
    return panel
