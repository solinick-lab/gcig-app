"""LSTM v2 — hybrid GRU + rich aggregations, 5-seed ensemble.

Five fixes from v1:

1. **Per-sequence normalization.** Each month's daily sequence is
   normalized to "% change from day 1 of that month". Strips out absolute
   price levels (which would otherwise dominate the loss as time-of-year
   noise) so the LSTM only sees the *shape* of the within-month moves.

2. **Hybrid architecture.** LSTM hidden state is CONCATENATED with the
   proven rich-features aggregation vector (from nowcast_richfeats),
   then a small linear head predicts the 3 quantile outputs. The LSTM
   only needs to add an incremental signal on top of features that
   already work — much easier learning problem than v1's "do everything".

3. **GRU instead of LSTM, hidden_dim=8.** ~150 parameters in the
   recurrent backbone instead of v1's ~700. With ~180 training rows,
   parameter count matters more than architectural sophistication.

4. **5-seed ensemble.** Train 5 GRUs with different random seeds,
   average the median-quantile predictions. Reduces variance from the
   init lottery — a single seed on tiny data is genuinely random.

5. **Stronger regularization.** Dropout 0.5 (was 0.3), weight_decay 1e-3
   (was 1e-4), longer patience (50 epochs).
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY, NowcastResult
from .nowcast_features import build_daily_frame, _DAILY_IDS
from .nowcast_richfeats import rich_features_at, _build_supervised_rich
from .features import build_target
from .fred import TARGET, fetch_panel
from .api_client import get_daily_panel

warnings.filterwarnings("ignore")

SEQ_FEATURES = list(_DAILY_IDS)
HIDDEN_DIM = 8
DROPOUT = 0.5
LR = 3e-3
EPOCHS = 400
PATIENCE = 50
WEIGHT_DECAY = 1e-3
N_SEEDS = 5
SEEDS = (42, 123, 456, 789, 1234)


def _torch_or_none():
    try:
        import torch
        return torch
    except ImportError:
        return None


def _per_sequence_norm(seq: np.ndarray) -> np.ndarray:
    """Normalize each feature column to % change from its day-1 value.
    Returns a (T, F) array where row 0 is all zeros and subsequent rows
    are (value_t / value_0 - 1) * 100. Drops absolute-level signal."""
    if seq.shape[0] == 0:
        return seq
    day1 = seq[0:1, :]
    # Avoid div-by-zero
    safe = np.where(np.abs(day1) < 1e-9, 1.0, day1)
    pct = (seq / safe - 1.0) * 100.0
    # Where day1 was effectively 0, just zero out the column
    pct = np.where(np.abs(day1) < 1e-9, 0.0, pct)
    return pct.astype(np.float32)


def _build_daily_sequence(daily_frame, as_of: pd.Timestamp) -> np.ndarray:
    """(T, n_seq_features) array of values from start of `as_of`'s month
    through `as_of`. Forward-filled within sequence."""
    month_start = pd.Timestamp(as_of.year, as_of.month, 1)
    all_dates = pd.date_range(month_start, as_of, freq="D")
    if len(all_dates) == 0:
        all_dates = pd.DatetimeIndex([as_of])
    cols = []
    for sid in SEQ_FEATURES:
        s = daily_frame.get(sid)
        if s is None or len(s) == 0:
            cols.append(np.zeros(len(all_dates)))
            continue
        before = s.loc[s.index < month_start]
        anchor = float(before.iloc[-1]) if len(before) > 0 else (
            float(s.iloc[0]) if len(s) > 0 else 0.0
        )
        within = s.loc[(s.index >= month_start) & (s.index <= as_of)]
        out = np.full(len(all_dates), anchor, dtype=float)
        if len(within) > 0:
            for d, v in zip(within.index, within.values):
                idx = (d - month_start).days
                if 0 <= idx < len(all_dates):
                    out[idx:] = float(v)
        cols.append(out)
    return np.stack(cols, axis=1)


def _build_supervised_v2(panel, daily_frame, as_of_day, min_history=36):
    """For each historical month: (per-month-normalized sequence,
    rich aggregation features, target MoM)."""
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
    eligible = y_mom.index[min_history:]

    sequences, agg_feats, targets, months = [], [], [], []
    for month_end in eligible:
        m_start = month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        seq = _build_daily_sequence(daily_frame, as_of)
        if seq.shape[0] == 0:
            continue
        seq_n = _per_sequence_norm(seq)
        # Rich aggregation features (the proven good ones)
        agg = rich_features_at(daily_frame, as_of)
        # Add CPI lag features
        if len(y_mom.loc[:month_end]) >= 3:
            agg["cpi_mom_lag1"] = float(y_mom.loc[:month_end].iloc[-2])
            agg["cpi_mom_lag2"] = float(y_mom.loc[:month_end].iloc[-3])
        else:
            continue
        if len(cpi.loc[:month_end]) >= 14:
            agg["cpi_yoy_lag1"] = float(
                (cpi.loc[:month_end].iloc[-2] / cpi.loc[:month_end].iloc[-14] - 1.0) * 100.0
            )
        else:
            agg["cpi_yoy_lag1"] = 0.0
        agg["month_sin"] = float(np.sin(2 * np.pi * month_end.month / 12.0))
        agg["month_cos"] = float(np.cos(2 * np.pi * month_end.month / 12.0))

        sequences.append(seq_n)
        agg_feats.append(agg)
        targets.append(float(y_mom.loc[month_end]))
        months.append(month_end)

    if not sequences:
        return [], pd.DataFrame(), np.array([]), []
    agg_df = pd.DataFrame(agg_feats).fillna(0.0)
    return sequences, agg_df, np.array(targets, dtype=np.float32), months


def _pad_sequences(seqs: list[np.ndarray]):
    max_len = max(s.shape[0] for s in seqs)
    n_features = seqs[0].shape[1]
    n = len(seqs)
    padded = np.zeros((n, max_len, n_features), dtype=np.float32)
    lengths = np.zeros(n, dtype=np.int64)
    for i, s in enumerate(seqs):
        L = s.shape[0]
        padded[i, :L, :] = s
        lengths[i] = L
    return padded, lengths


def _train_one_gru(seqs_padded, lengths, agg_X, y, n_seq_features, n_agg_features, seed, torch):
    """Train a single GRU model with a given seed. Returns the trained model."""
    import torch.nn as nn
    torch.manual_seed(seed)
    np.random.seed(seed)

    class HybridGRU(nn.Module):
        def __init__(self, n_seq, n_agg, hidden=HIDDEN_DIM):
            super().__init__()
            self.gru = nn.GRU(n_seq, hidden, num_layers=1, batch_first=True)
            self.dropout = nn.Dropout(DROPOUT)
            self.head = nn.Sequential(
                nn.Linear(hidden + n_agg, 16),
                nn.ReLU(),
                nn.Dropout(DROPOUT),
                nn.Linear(16, 3),
            )

        def forward(self, seq, lengths, agg):
            packed = nn.utils.rnn.pack_padded_sequence(
                seq, lengths.cpu(), batch_first=True, enforce_sorted=False
            )
            _, h = self.gru(packed)
            h = h[-1]
            h = self.dropout(h)
            x = torch.cat([h, agg], dim=1)
            return self.head(x)

    seq_t = torch.tensor(seqs_padded)
    len_t = torch.tensor(lengths)
    agg_t = torch.tensor(agg_X)
    y_t = torch.tensor(y).reshape(-1, 1)

    n = len(y)
    split = max(1, int(n * 0.85))
    model = HybridGRU(n_seq_features, n_agg_features)
    opt = torch.optim.Adam(model.parameters(), lr=LR, weight_decay=WEIGHT_DECAY)
    QS = torch.tensor([0.1, 0.5, 0.9])

    def pinball(y_true, y_pred):
        diff = y_true - y_pred
        return (torch.maximum(QS * diff, (QS - 1) * diff)).mean()

    best_val = float("inf")
    best_state = None
    patience_left = PATIENCE
    for epoch in range(EPOCHS):
        model.train()
        opt.zero_grad()
        pred = model(seq_t[:split], len_t[:split], agg_t[:split])
        loss = pinball(y_t[:split], pred)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()

        model.eval()
        with torch.no_grad():
            val_pred = model(seq_t[split:], len_t[split:], agg_t[split:])
            val_loss = pinball(y_t[split:], val_pred).item()
        if val_loss < best_val - 1e-5:
            best_val = val_loss
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
            patience_left = PATIENCE
        else:
            patience_left -= 1
            if patience_left <= 0:
                break

    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()
    return model


def _predict_ensemble(models, seq_norm: np.ndarray, agg_x: np.ndarray, torch) -> tuple[float, float, float]:
    """Average predictions across the ensemble of seeded models."""
    seq_t = torch.tensor(seq_norm[None, :, :].astype(np.float32))
    len_t = torch.tensor([seq_norm.shape[0]], dtype=torch.int64)
    agg_t = torch.tensor(agg_x[None, :].astype(np.float32))
    preds = []
    with torch.no_grad():
        for m in models:
            out = m(seq_t, len_t, agg_t)
            preds.append(out[0].numpy())
    p = np.mean(np.stack(preds, axis=0), axis=0)  # avg over seeds
    p = np.sort(p)
    lo, mid, hi = float(p[0]), float(p[1]), float(p[2])
    mid = float(np.clip(mid, -1.5, 2.5))
    return mid, lo, hi


def backtest_lstm_v2_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict,
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    torch = _torch_or_none()
    if torch is None:
        return {"error": "PyTorch not installed."}

    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
    cuts = list(range(len(y_mom) - window_months, len(y_mom)))

    rows = []
    pm_arr, am_arr, py_arr, ay_arr = [], [], [], []
    for ci in cuts:
        target_month_end = y_mom.index[ci]
        train_panel = panel.loc[panel.index < target_month_end]
        if len(train_panel) < 60:
            continue
        try:
            seqs, agg_df, targets, _ = _build_supervised_v2(train_panel, daily_frame, as_of_day)
            if len(seqs) < 36:
                continue
            n_seq_feat = seqs[0].shape[1]
            n_agg_feat = agg_df.shape[1]
            agg_mean = agg_df.mean(axis=0).values
            agg_std = agg_df.std(axis=0).values + 1e-6
            agg_X = ((agg_df.values - agg_mean) / agg_std).astype(np.float32)
            padded, lengths = _pad_sequences(seqs)
            # Train ensemble
            models = []
            for seed in SEEDS:
                models.append(_train_one_gru(
                    padded, lengths, agg_X, targets,
                    n_seq_feat, n_agg_feat, seed, torch
                ))
        except Exception:
            continue

        # Inference
        m_start = target_month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        try:
            seq_inf = _build_daily_sequence(daily_frame, as_of)
            seq_inf_n = _per_sequence_norm(seq_inf)
            agg_inf = rich_features_at(daily_frame, as_of)
            train_y = build_target(train_panel).dropna()
            agg_inf["cpi_mom_lag1"] = float(train_y.iloc[-1])
            agg_inf["cpi_mom_lag2"] = float(train_y.iloc[-2]) if len(train_y) >= 2 else 0.0
            agg_inf["cpi_yoy_lag1"] = float(
                (train_panel[TARGET.fred_id].dropna().iloc[-1]
                 / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0) * 100.0
            ) if len(train_panel[TARGET.fred_id].dropna()) >= 13 else 0.0
            agg_inf["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
            agg_inf["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
            # Align to training columns
            agg_vec = pd.Series(agg_inf).reindex(agg_df.columns).fillna(0.0).values
            agg_vec_n = ((agg_vec - agg_mean) / agg_std).astype(np.float32)
            mid, lo, hi = _predict_ensemble(models, seq_inf_n, agg_vec_n, torch)
        except Exception:
            continue

        actual_mom = float(y_mom.iloc[ci])
        last_cpi_train = float(train_panel[TARGET.fred_id].dropna().iloc[-1])
        pred_cpi = last_cpi_train * float(np.exp(mid / 100.0))
        denom_idx = target_month_end - pd.DateOffset(years=1)
        denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
        try:
            denom = float(cpi.loc[denom_idx])
        except KeyError:
            denom = float(cpi.asof(denom_idx))
        pred_yoy = (pred_cpi / denom - 1.0) * 100.0
        actual_cpi = float(cpi.loc[target_month_end])
        actual_yoy = (actual_cpi / denom - 1.0) * 100.0

        pm_arr.append(mid); am_arr.append(actual_mom)
        py_arr.append(pred_yoy); ay_arr.append(actual_yoy)
        rows.append({
            "target_month": target_month_end.strftime("%Y-%m"),
            "as_of": as_of.strftime("%Y-%m-%d"),
            "pred_mom": round(mid, 4),
            "actual_mom": round(actual_mom, 4),
            "pred_yoy": round(pred_yoy, 3),
            "actual_yoy": round(actual_yoy, 3),
            "yoy_err": round(pred_yoy - actual_yoy, 3),
        })

    if not pm_arr:
        return {"error": "no successful cuts"}

    pm = np.array(pm_arr); am = np.array(am_arr)
    py = np.array(py_arr); ay = np.array(ay_arr)
    yoy_err = np.abs(py - ay)
    return {
        "asOfDay": as_of_day,
        "windowMonths": window_months,
        "totalCuts": len(pm),
        "rmseMom": float(np.sqrt(np.mean((pm - am) ** 2))),
        "rmseYoy": float(np.sqrt(np.mean((py - ay) ** 2))),
        "maeYoy": float(np.mean(yoy_err)),
        "hitWithin25bp": float((yoy_err <= 0.25).mean()) * 100,
        "hitWithin50bp": float((yoy_err <= 0.50).mean()) * 100,
        "rows": rows,
    }


def run_lstm_v2_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> NowcastResult:
    torch = _torch_or_none()
    if torch is None:
        raise RuntimeError("PyTorch not installed.")

    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    seqs, agg_df, targets, _ = _build_supervised_v2(panel, daily_frame, as_of_day)
    n_seq_feat = seqs[0].shape[1]
    n_agg_feat = agg_df.shape[1]
    agg_mean = agg_df.mean(axis=0).values
    agg_std = agg_df.std(axis=0).values + 1e-6
    agg_X = ((agg_df.values - agg_mean) / agg_std).astype(np.float32)
    padded, lengths = _pad_sequences(seqs)
    models = []
    for seed in SEEDS:
        models.append(_train_one_gru(padded, lengths, agg_X, targets,
                                     n_seq_feat, n_agg_feat, seed, torch))

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    seq_inf = _build_daily_sequence(daily_frame, as_of)
    seq_inf_n = _per_sequence_norm(seq_inf)
    y_mom = build_target(panel).dropna()
    agg_inf = rich_features_at(daily_frame, as_of)
    agg_inf["cpi_mom_lag1"] = float(y_mom.iloc[-1])
    agg_inf["cpi_mom_lag2"] = float(y_mom.iloc[-2])
    agg_inf["cpi_yoy_lag1"] = float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0)
    agg_inf["month_sin"] = float(np.sin(2 * np.pi * target_month_end.month / 12.0))
    agg_inf["month_cos"] = float(np.cos(2 * np.pi * target_month_end.month / 12.0))
    agg_vec = pd.Series(agg_inf).reindex(agg_df.columns).fillna(0.0).values
    agg_vec_n = ((agg_vec - agg_mean) / agg_std).astype(np.float32)
    mid, lo, hi = _predict_ensemble(models, seq_inf_n, agg_vec_n, torch)

    last_cpi = float(cpi.iloc[-1])
    pred_cpi = last_cpi * float(np.exp(mid / 100.0))
    denom_idx = target_month_end - pd.DateOffset(years=1)
    denom_idx = pd.Timestamp(denom_idx) + pd.offsets.MonthEnd(0)
    try:
        denom = float(cpi.loc[denom_idx])
    except KeyError:
        denom = float(cpi.asof(denom_idx))
    yoy_mid = (pred_cpi / denom - 1.0) * 100.0
    yoy_lo = (last_cpi * float(np.exp(lo / 100.0)) / denom - 1.0) * 100.0
    yoy_hi = (last_cpi * float(np.exp(hi / 100.0)) / denom - 1.0) * 100.0

    days_observed = sum(
        1 for s in daily_frame.values()
        if len(s.loc[(s.index >= target_month_start) & (s.index <= as_of)]) > 0
    )
    return NowcastResult(
        as_of=as_of,
        target_month=target_month_end.strftime("%Y-%m"),
        pred_mom=mid,
        pred_yoy=yoy_mid,
        lo80_yoy=yoy_lo,
        hi80_yoy=yoy_hi,
        days_observed=days_observed,
    )
