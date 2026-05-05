from __future__ import annotations

from pathlib import Path

import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots


def render_report(result: dict, *, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    signal = result["signal"]
    target = result["target"]
    ic_table = pd.DataFrame({
        "IC": pd.Series(result["ic"]),
        "IC_stability": pd.Series(result.get("ic_stability", {})),
    })
    ic_table.index.name = "horizon_d"

    horizons = sorted(result["ic"].keys())
    fig_pnl = make_subplots(
        rows=len(horizons), cols=1, shared_xaxes=True,
        subplot_titles=[f"long-short cumulative P&L (h={h}d)" for h in horizons],
    )
    for i, h in enumerate(horizons, start=1):
        pnl = result["pnl"][h]
        if pnl.empty:
            continue
        fig_pnl.add_trace(
            go.Scatter(x=pnl.index, y=pnl.cumsum(), mode="lines", name=f"h={h}"),
            row=i, col=1,
        )
    fig_pnl.update_layout(height=200 * len(horizons), showlegend=False)

    fig_b = make_subplots(
        rows=1, cols=len(horizons),
        subplot_titles=[f"deciles (h={h}d)" for h in horizons],
    )
    for i, h in enumerate(horizons, start=1):
        b = result["buckets"][h]
        if b.empty:
            continue
        fig_b.add_trace(go.Bar(x=b.index.astype(str), y=b.values, name=f"h={h}"), row=1, col=i)
    fig_b.update_layout(height=300, showlegend=False)

    html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{signal} vs {target}</title>
<style>body{{font-family:system-ui;max-width:1200px;margin:2em auto;padding:0 1em}}
table{{border-collapse:collapse}} th,td{{padding:.4em .8em;border:1px solid #ddd}}</style>
</head><body>
<h1>{signal} → {target}</h1>
<h2>Information Coefficient</h2>
{ic_table.to_html()}
<h2>Long-short P&L</h2>
{fig_pnl.to_html(full_html=False, include_plotlyjs="cdn")}
<h2>Bucket forward returns</h2>
{fig_b.to_html(full_html=False, include_plotlyjs=False)}
</body></html>
"""
    out_path.write_text(html)
