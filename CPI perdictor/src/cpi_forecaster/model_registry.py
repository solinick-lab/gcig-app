"""Fed Chair naming convention for CPI forecasters.

Each model has:
  - chair: Fed Chair name (Burns/Volcker/Greenspan/Yellen/Powell)
  - version: semantic-versioned X.Y string
  - description: one-line summary
  - module: Python module that implements the strategy
  - run_fn: function name to call for live nowcast/forecast
  - backtest_fn: function name to call for backtest
  - production: True if currently deployed
  - rmse: best measured RMSE YoY on the 24-month nowcaster backtest

Higher Chairs (later in time) generally indicate more sophisticated
architectures — Burns era had the highest inflation and crudest tools,
Powell era integrates everything. Within a Chair, version increments
indicate refinements (e.g., Yellen 1.0 → Yellen 1.1 = bias-correction
layer added).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelEntry:
    chair: str
    version: str
    description: str
    module: str
    run_fn: str | None       # function name in the module for live forecast
    backtest_fn: str | None  # function name for the backtest
    production: bool         # currently deployed in production?
    rmse: float | None       # best measured RMSE YoY on the nowcaster backtest

    @property
    def label(self) -> str:
        return f"{self.chair} {self.version}"

    @property
    def slug(self) -> str:
        return f"{self.chair.lower()}-{self.version.replace('.', '-')}"


REGISTRY: tuple[ModelEntry, ...] = (
    # ── Burns era (baseline / high-inflation era tools) ─────────────────
    ModelEntry(
        chair="Burns", version="1.0",
        description="Equal-weighted SARIMA + Ridge + XGBoost monthly forecast",
        module="cpi_forecaster.strategies.baseline",
        run_fn=None, backtest_fn=None,
        production=False, rmse=0.290,
    ),
    ModelEntry(
        chair="Burns", version="2.0",
        description="Random Fourier Features + Ridge (RFF — round-4 monthly winner)",
        module="cpi_forecaster.strategies.agent_s_rff",
        run_fn=None, backtest_fn=None,
        production=False, rmse=0.245,
    ),
    # ── Volcker era (quantile loss = aggressive on tails) ───────────────
    ModelEntry(
        chair="Volcker", version="1.0",
        description="Quantile regression (q=0.5) on within-month features",
        module="cpi_forecaster.nowcast_quantile",
        run_fn="run_quantile_nowcast", backtest_fn="backtest_quantile_nowcast",
        production=False, rmse=0.1451,
    ),
    ModelEntry(
        chair="Volcker", version="1.1",
        description="Quantile + rich features (multi-window momentum)",
        module="cpi_forecaster.nowcast_quantile_rich",
        run_fn="run_quantile_rich_nowcast", backtest_fn="backtest_quantile_rich_nowcast",
        production=False, rmse=0.1341,
    ),
    # ── Greenspan era (balanced, multi-component) ───────────────────────
    ModelEntry(
        chair="Greenspan", version="1.0",
        description="5-way subcomponent decomposition (Food/Energy/Shelter/Other)",
        module="cpi_forecaster.nowcast_subcomp_5way",
        run_fn="run_subcomp_5way_nowcast", backtest_fn="backtest_subcomp_5way_nowcast",
        production=False, rmse=0.1295,
    ),
    ModelEntry(
        chair="Greenspan", version="1.1",
        description="Shelter-first hierarchical (dedicated Zillow-driven shelter forecaster)",
        module="cpi_forecaster.nowcast_shelter_first",
        run_fn="run_shelter_first_nowcast", backtest_fn="backtest_shelter_first_nowcast",
        production=False, rmse=0.1269,
    ),
    # ── Yellen era (data-driven, external-source integration) ───────────
    ModelEntry(
        chair="Yellen", version="1.0",
        description="Cleveland Fed nowcast as feature + quantile_rich base",
        module="cpi_forecaster.nowcast_clev",
        run_fn="run_clev_nowcast", backtest_fn="backtest_clev_nowcast",
        production=False, rmse=0.1206,
    ),
    ModelEntry(
        chair="Yellen", version="1.1",
        description="Yellen 1.0 + Ridge bias-correction calibrator",
        module="cpi_forecaster.nowcast_clev_calibrated",
        run_fn="run_clev_calibrated_nowcast", backtest_fn="backtest_clev_calibrated_nowcast",
        production=False,
        rmse=0.1142,
    ),
    ModelEntry(
        chair="Yellen", version="1.2",
        description="Yellen 1.0 + trajectory features (Cleveland nowcast slope/acceleration)",
        module="cpi_forecaster.nowcast_clev_trajectory",
        run_fn="run_clev_trajectory_nowcast", backtest_fn="backtest_clev_trajectory_nowcast",
        production=False, rmse=0.1204,
    ),
    ModelEntry(
        chair="Yellen", version="1.3",
        description="Yellen 1.1 + AR(2) correction on in-sample residuals",
        module="cpi_forecaster.nowcast_ar_residual",
        run_fn="run_ar_residual_nowcast", backtest_fn="backtest_ar_residual_nowcast",
        production=True,                        # ← current production
        rmse=0.1132,
    ),
    # ── Powell era (ensembles, combined models) ─────────────────────────
    ModelEntry(
        chair="Powell", version="1.0",
        description="Mega-ensemble of top 4 models (median + inverse-RMSE + stacked)",
        module="cpi_forecaster.nowcast_megaens",
        run_fn="run_megaens_nowcast", backtest_fn="backtest_megaens_nowcast",
        production=False, rmse=0.1257,
    ),
    ModelEntry(
        chair="Powell", version="1.1",
        description="Top-2 stack (Yellen 1.0 + Greenspan 1.1)",
        module="cpi_forecaster.nowcast_top2_stack",
        run_fn="run_top2_stack_nowcast", backtest_fn="backtest_top2_stack_nowcast",
        production=False, rmse=0.1210,
    ),
)


def production() -> ModelEntry:
    """Return the model currently deployed in production."""
    for m in REGISTRY:
        if m.production:
            return m
    raise RuntimeError("No production model marked in registry")


def by_label(label: str) -> ModelEntry | None:
    """Look up by 'Yellen 1.1' or 'yellen-1-1' style label."""
    norm = label.lower().replace(" ", "-").replace(".", "-")
    for m in REGISTRY:
        if m.slug == norm or m.label.lower() == label.lower():
            return m
    return None
