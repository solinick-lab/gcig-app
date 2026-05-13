"""LSTM nowcaster — ingests the RAW daily price sequence directly.

The big idea: every other model in the race collapses ~22 days of daily
prices into a handful of aggregation features (3-day momentum, MTD avg,
volatility). That throws away the SEQUENCE — the order in which prices
moved within the month.

An LSTM can ingest the daily sequence directly and learn its own
aggregations end-to-end with the prediction objective. If the order
matters (e.g., late-month price spikes are more predictive than
early-month ones), the LSTM has a chance to find that signal where
GBR/Ridge can't.

Honest expectations: with ~180 training rows, this is small-data
territory. Heavy regularization (dropout, early stopping, tiny hidden
dim) is required. Realistic outcomes: 30% chance it beats quantile_rich
(≤0.13), 50% chance it ties (~0.13-0.15), 20% chance it overfits and
loses (>0.15).

Architecture:
  - Input per timestep: ~10 daily features (WTI, Brent, gas, USD, yields,
    TIPS, HY spread). Variable sequence length: 1 to 30 days.
  - LSTM (1 layer, hidden_dim=16) summarizes the sequence to a final state.
  - Concat with monthly lag features (~6 dims).
  - Linear head outputs 3 quantiles (q=0.1, 0.5, 0.9).
  - Pinball loss for proper quantile regression.

Requires PyTorch — install on WSL with:
    pip install torch --index-url https://download.pytorch.org/whl/cpu
"""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd

from .nowcast import _as_of_for_month, DEFAULT_AS_OF_DAY, NowcastResult
from .nowcast_features import build_daily_frame, _DAILY_IDS
from .features import build_target
from .fred import TARGET, fetch_panel
from .api_client import get_daily_panel

warnings.filterwarnings("ignore")

# Hyperparameters — tuned for tiny data.
SEQ_FEATURES = list(_DAILY_IDS)  # 11 daily series
HIDDEN_DIM = 16
DROPOUT = 0.3
LR = 5e-3
EPOCHS = 300
PATIENCE = 30
SEED = 42


def _torch_or_none():
    try:
        import torch
        return torch
    except ImportError:
        return None


def _build_daily_sequence(daily_frame, as_of: pd.Timestamp, max_days: int = 31) -> np.ndarray:
    """Return a (T, n_features) array of daily values from the start of
    `as_of`'s month through `as_of`. Missing values forward-filled within the
    sequence; if a series is entirely absent, fill with the latest known value
    from before the month start.
    """
    month_start = pd.Timestamp(as_of.year, as_of.month, 1)
    # Build a daily date range
    all_dates = pd.date_range(month_start, as_of, freq="D")
    if len(all_dates) == 0:
        all_dates = pd.DatetimeIndex([as_of])

    cols = []
    for sid in SEQ_FEATURES:
        s = daily_frame.get(sid)
        if s is None or len(s) == 0:
            cols.append(np.zeros(len(all_dates)))
            continue
        # Get the most recent value before month start (the "anchor")
        before_month = s.loc[s.index < month_start]
        if len(before_month) > 0:
            anchor = float(before_month.iloc[-1])
        else:
            anchor = float(s.iloc[0]) if len(s) > 0 else 0.0
        # Get values within month, forward-fill, anchor as initial.
        within = s.loc[(s.index >= month_start) & (s.index <= as_of)]
        out = np.full(len(all_dates), anchor, dtype=float)
        if len(within) > 0:
            for d, v in zip(within.index, within.values):
                idx = (d - month_start).days
                if 0 <= idx < len(all_dates):
                    out[idx:] = float(v)
        cols.append(out)
    arr = np.stack(cols, axis=1)  # (T, n_features)
    # Per-column z-score using all of `s.loc[s.index < as_of]` — but for
    # speed we just demean and divide by recent std at predict time.
    return arr


def _normalize_sequences(sequences: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """Stack variable-length sequences into a padded tensor.
    Returns (padded, lengths, masks, max_len). Sequences are left-padded with zeros."""
    max_len = max(s.shape[0] for s in sequences)
    n_features = sequences[0].shape[1]
    n = len(sequences)
    padded = np.zeros((n, max_len, n_features), dtype=np.float32)
    masks = np.zeros((n, max_len), dtype=np.float32)
    lengths = np.zeros(n, dtype=np.int64)
    for i, s in enumerate(sequences):
        L = s.shape[0]
        padded[i, :L, :] = s
        masks[i, :L] = 1.0
        lengths[i] = L
    return padded, lengths, masks, max_len


def _build_supervised(panel, daily_frame, as_of_day, min_history=36):
    """For each historical month, build (sequence, monthly_features, target)."""
    cpi = panel[TARGET.fred_id].dropna()
    y_mom = build_target(panel).dropna()
    eligible = y_mom.index[min_history:]

    sequences = []
    monthly = []
    targets = []
    months = []
    for month_end in eligible:
        m_start = month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        seq = _build_daily_sequence(daily_frame, as_of)
        if seq.shape[0] == 0:
            continue
        # Monthly features
        feats = []
        feats.append(float(y_mom.loc[:month_end].iloc[-2]))       # cpi_mom_lag1
        feats.append(float(y_mom.loc[:month_end].iloc[-3]) if len(y_mom.loc[:month_end]) >= 3 else 0.0)
        if len(cpi.loc[:month_end]) >= 14:
            feats.append(float(
                (cpi.loc[:month_end].iloc[-2] / cpi.loc[:month_end].iloc[-14] - 1.0) * 100.0
            ))
        else:
            feats.append(0.0)
        feats.append(float(np.sin(2 * np.pi * month_end.month / 12.0)))
        feats.append(float(np.cos(2 * np.pi * month_end.month / 12.0)))
        sequences.append(seq.astype(np.float32))
        monthly.append(np.array(feats, dtype=np.float32))
        targets.append(float(y_mom.loc[month_end]))
        months.append(month_end)

    return sequences, np.stack(monthly) if monthly else np.zeros((0, 5)), np.array(targets, dtype=np.float32), months


def _normalize_features(seqs: list[np.ndarray], monthly: np.ndarray):
    """Per-feature z-score normalization. Returns normalized arrays + the
    statistics needed to apply the same transform at inference."""
    if not seqs:
        return seqs, monthly, None, None
    # Compute stats from concat of all sequence values
    all_seq = np.concatenate(seqs, axis=0)  # (sum_T, n_features)
    seq_mean = all_seq.mean(axis=0)
    seq_std = all_seq.std(axis=0) + 1e-6
    norm_seqs = [(s - seq_mean) / seq_std for s in seqs]

    m_mean = monthly.mean(axis=0)
    m_std = monthly.std(axis=0) + 1e-6
    norm_monthly = (monthly - m_mean) / m_std

    return norm_seqs, norm_monthly, (seq_mean, seq_std), (m_mean, m_std)


def _apply_norm(seq, monthly, seq_stats, m_stats):
    seq_mean, seq_std = seq_stats
    m_mean, m_std = m_stats
    return (seq - seq_mean) / seq_std, (monthly - m_mean) / m_std


def _train_lstm(sequences, monthly_features, targets, n_features_seq, n_features_monthly, torch):
    """Train an LSTM with quantile loss. Returns the trained model."""
    import torch.nn as nn
    torch.manual_seed(SEED)
    np.random.seed(SEED)

    class QuantileLSTM(nn.Module):
        def __init__(self, n_seq_features, n_monthly_features, hidden_dim=HIDDEN_DIM):
            super().__init__()
            self.lstm = nn.LSTM(n_seq_features, hidden_dim, num_layers=1, batch_first=True)
            self.dropout = nn.Dropout(DROPOUT)
            self.head = nn.Sequential(
                nn.Linear(hidden_dim + n_monthly_features, 16),
                nn.ReLU(),
                nn.Dropout(DROPOUT),
                nn.Linear(16, 3),  # 3 quantile outputs
            )

        def forward(self, seq, lengths, monthly):
            # seq: (B, T, F), lengths: (B,), monthly: (B, M)
            packed = nn.utils.rnn.pack_padded_sequence(
                seq, lengths.cpu(), batch_first=True, enforce_sorted=False
            )
            _, (h, _) = self.lstm(packed)
            h = h[-1]  # (B, hidden_dim)
            h = self.dropout(h)
            x = torch.cat([h, monthly], dim=1)
            return self.head(x)  # (B, 3)

    padded, lengths, _, _ = _normalize_sequences(sequences)
    seq_t = torch.tensor(padded)
    len_t = torch.tensor(lengths)
    mon_t = torch.tensor(monthly_features)
    y_t = torch.tensor(targets).reshape(-1, 1)

    model = QuantileLSTM(n_features_seq, n_features_monthly)
    opt = torch.optim.Adam(model.parameters(), lr=LR, weight_decay=1e-4)

    QS = torch.tensor([0.1, 0.5, 0.9])

    def pinball_loss(y_true, y_pred):
        # y_true: (B, 1), y_pred: (B, 3)
        diff = y_true - y_pred  # (B, 3)
        return (torch.maximum(QS * diff, (QS - 1) * diff)).mean()

    # Hold last 15% as validation for early stopping
    n = len(targets)
    split = max(1, int(n * 0.85))
    best_val = float("inf")
    best_state = None
    patience_left = PATIENCE

    for epoch in range(EPOCHS):
        model.train()
        opt.zero_grad()
        pred = model(seq_t[:split], len_t[:split], mon_t[:split])
        loss = pinball_loss(y_t[:split], pred)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()

        model.eval()
        with torch.no_grad():
            val_pred = model(seq_t[split:], len_t[split:], mon_t[split:])
            val_loss = pinball_loss(y_t[split:], val_pred).item()
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


def _predict(model, seq_norm, monthly_norm, torch):
    import torch.nn as nn
    seq_t = torch.tensor(seq_norm[None, :, :].astype(np.float32))  # (1, T, F)
    len_t = torch.tensor([seq_norm.shape[0]], dtype=torch.int64)
    mon_t = torch.tensor(monthly_norm[None, :].astype(np.float32))
    with torch.no_grad():
        out = model(seq_t, len_t, mon_t)
    p = out[0].numpy()
    p = np.sort(p)
    lo, mid, hi = float(p[0]), float(p[1]), float(p[2])
    mid = float(np.clip(mid, -1.5, 2.5))
    return mid, lo, hi


def backtest_lstm_nowcast(
    panel: pd.DataFrame,
    daily_frame: dict,
    window_months: int = 24,
    as_of_day: int = DEFAULT_AS_OF_DAY,
) -> dict:
    torch = _torch_or_none()
    if torch is None:
        return {"error": "PyTorch not installed. Run `pip install torch --index-url https://download.pytorch.org/whl/cpu` in your venv."}

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
            seqs, monthly, targets, _ = _build_supervised(train_panel, daily_frame, as_of_day)
            if len(seqs) < 36:
                continue
            n_seq_feat = seqs[0].shape[1]
            n_mon_feat = monthly.shape[1]
            seqs_n, monthly_n, seq_stats, m_stats = _normalize_features(seqs, monthly)
            model = _train_lstm(seqs_n, monthly_n, targets, n_seq_feat, n_mon_feat, torch)
        except Exception as e:
            continue

        # Build inference for this cut
        m_start = target_month_end + pd.offsets.MonthBegin(-1)
        as_of = _as_of_for_month(m_start, as_of_day)
        try:
            seq_inf = _build_daily_sequence(daily_frame, as_of)
            train_y = build_target(train_panel).dropna()
            mon_inf = np.array([
                float(train_y.iloc[-1]),
                float(train_y.iloc[-2]) if len(train_y) >= 2 else 0.0,
                float(
                    (train_panel[TARGET.fred_id].dropna().iloc[-1]
                     / train_panel[TARGET.fred_id].dropna().iloc[-13] - 1.0) * 100.0
                ) if len(train_panel[TARGET.fred_id].dropna()) >= 13 else 0.0,
                float(np.sin(2 * np.pi * target_month_end.month / 12.0)),
                float(np.cos(2 * np.pi * target_month_end.month / 12.0)),
            ], dtype=np.float32)
            seq_n, mon_n = _apply_norm(seq_inf.astype(np.float32), mon_inf, seq_stats, m_stats)
            mid, lo, hi = _predict(model, seq_n, mon_n, torch)
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


def run_lstm_nowcast(as_of_day: int = DEFAULT_AS_OF_DAY) -> NowcastResult:
    torch = _torch_or_none()
    if torch is None:
        raise RuntimeError("PyTorch not installed. `pip install torch --index-url https://download.pytorch.org/whl/cpu`")

    panel = fetch_panel()
    daily_panel = get_daily_panel()
    daily_frame = build_daily_frame(daily_panel)

    seqs, monthly, targets, _ = _build_supervised(panel, daily_frame, as_of_day)
    n_seq_feat = seqs[0].shape[1]
    n_mon_feat = monthly.shape[1]
    seqs_n, monthly_n, seq_stats, m_stats = _normalize_features(seqs, monthly)
    model = _train_lstm(seqs_n, monthly_n, targets, n_seq_feat, n_mon_feat, torch)

    today = pd.Timestamp.utcnow().tz_localize(None).normalize()
    cpi = panel[TARGET.fred_id].dropna()
    last_released_month_end = cpi.index[-1]
    target_month_end = (last_released_month_end + pd.offsets.MonthBegin(1)) + pd.offsets.MonthEnd(0)
    target_month_start = target_month_end + pd.offsets.MonthBegin(-1)
    as_of = min(today, target_month_end)
    if today < target_month_start:
        as_of = _as_of_for_month(target_month_start, as_of_day)

    seq_inf = _build_daily_sequence(daily_frame, as_of)
    y_mom = build_target(panel).dropna()
    mon_inf = np.array([
        float(y_mom.iloc[-1]),
        float(y_mom.iloc[-2]),
        float((cpi.iloc[-1] / cpi.iloc[-13] - 1.0) * 100.0),
        float(np.sin(2 * np.pi * target_month_end.month / 12.0)),
        float(np.cos(2 * np.pi * target_month_end.month / 12.0)),
    ], dtype=np.float32)

    seq_n, mon_n = _apply_norm(seq_inf.astype(np.float32), mon_inf, seq_stats, m_stats)
    mid, lo, hi = _predict(model, seq_n, mon_n, torch)

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
