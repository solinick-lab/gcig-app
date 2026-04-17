import { useEffect, useState } from 'react';
import { ExternalLink, TrendingUp, TrendingDown } from 'lucide-react';
import api from '../api/client.js';
import { safeHref } from '../api/safeUrl.js';
import Modal from './Modal.jsx';

function fmtMoney(n, currency = 'USD') {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  });
}

// Compact dollar for large numbers — $2.14T / $812.4B / $1.23M.
function fmtBig(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtInt(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

function fmtNum(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toFixed(digits);
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${(n * 100).toFixed(2)}%`;
}

export default function HoldingDetailModal({ holding, onClose }) {
  const ticker = holding?.ticker;
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setInfo(null);
    api
      .get(`/holdings/info/${encodeURIComponent(ticker)}`)
      .then(({ data }) => {
        if (!cancelled) setInfo(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || 'Failed to load ticker info');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  // Our position math — pulled from the sheet-derived holding object.
  const ourMarketValue =
    holding?.marketValue ??
    (holding?.shares != null && holding?.price != null
      ? holding.shares * holding.price
      : null);
  const ourReturnUp = (holding?.dollarReturn ?? 0) >= 0;

  const dayChange =
    info?.price != null && info?.previousClose != null
      ? info.price - info.previousClose
      : null;
  const dayChangePct =
    dayChange != null && info?.previousClose
      ? (dayChange / info.previousClose) * 100
      : null;
  const up = dayChange != null && dayChange >= 0;

  return (
    <Modal
      open={!!holding}
      onClose={onClose}
      title={info ? `${info.ticker} — ${info.name}` : ticker || ''}
      size="lg"
    >
      {loading ? (
        <div className="py-12 text-center text-sm text-navy-400">Loading ticker info…</div>
      ) : error ? (
        <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</div>
      ) : info ? (
        <div className="space-y-5">
          {/* Price block */}
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-navy-50 pb-4">
            <div>
              <div className="text-3xl font-bold text-navy">
                {fmtMoney(info.price, info.currency)}
              </div>
              {dayChange != null && (
                <div
                  className={`mt-1 flex items-center gap-1 text-sm font-semibold ${
                    up ? 'text-emerald-600' : 'text-red-600'
                  }`}
                >
                  {up ? (
                    <TrendingUp className="h-4 w-4" />
                  ) : (
                    <TrendingDown className="h-4 w-4" />
                  )}
                  {up ? '+' : ''}
                  {fmtMoney(dayChange, info.currency)} ({up ? '+' : ''}
                  {dayChangePct?.toFixed(2)}%) today
                </div>
              )}
              {(info.sector || info.industry) && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {info.sector && (
                    <span className="rounded-full bg-navy-50 px-2 py-0.5 text-[11px] font-semibold text-navy">
                      {info.sector}
                    </span>
                  )}
                  {info.industry && info.industry !== info.sector && (
                    <span className="rounded-full bg-gold-100 px-2 py-0.5 text-[11px] font-semibold text-gold-800">
                      {info.industry}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="text-right text-xs text-navy-400">
              {info.exchange && <div>{info.exchange}</div>}
              {info.country && <div>{info.country}</div>}
            </div>
          </div>

          {/* Our Position — data from the club's Google Sheet */}
          {holding && !holding.isCash && (
            <div className="rounded-lg border border-gold-300 bg-gold-100/40 p-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-xs font-bold uppercase tracking-wider text-gold-800">
                  Our Position
                </div>
                {holding.portfolioPct != null && (
                  <div className="text-xs font-semibold text-navy">
                    {holding.portfolioPct.toFixed(2)}% of portfolio
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                <Stat
                  label="Shares"
                  value={holding.shares != null ? holding.shares.toLocaleString('en-US') : '—'}
                />
                <Stat
                  label="Avg Cost"
                  value={fmtMoney(holding.costBasis, info.currency)}
                />
                <Stat
                  label="Market Value"
                  value={fmtMoney(ourMarketValue, info.currency)}
                />
                <Stat
                  label="Return"
                  value={
                    <span
                      className={
                        ourReturnUp ? 'text-emerald-600' : 'text-red-600'
                      }
                    >
                      {fmtMoney(holding.dollarReturn, info.currency)}
                      {holding.percentReturn != null && (
                        <span className="ml-1 text-xs">
                          ({ourReturnUp ? '+' : ''}
                          {holding.percentReturn.toFixed(2)}%)
                        </span>
                      )}
                    </span>
                  }
                />
              </div>
            </div>
          )}

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
            <Stat label="Previous Close" value={fmtMoney(info.previousClose, info.currency)} />
            <Stat
              label="Day Range"
              value={
                info.dayLow != null && info.dayHigh != null
                  ? `${fmtMoney(info.dayLow, info.currency)} – ${fmtMoney(info.dayHigh, info.currency)}`
                  : '—'
              }
            />
            <Stat
              label="52-Week Range"
              value={
                info.fiftyTwoWeekLow != null && info.fiftyTwoWeekHigh != null
                  ? `${fmtMoney(info.fiftyTwoWeekLow, info.currency)} – ${fmtMoney(info.fiftyTwoWeekHigh, info.currency)}`
                  : '—'
              }
            />
            <Stat label="Market Cap" value={fmtBig(info.marketCap)} />
            <Stat label="P/E (Trailing)" value={fmtNum(info.trailingPE)} />
            <Stat label="P/E (Forward)" value={fmtNum(info.forwardPE)} />
            <Stat label="Dividend Yield" value={fmtPct(info.dividendYield)} />
            <Stat label="Beta" value={fmtNum(info.beta)} />
            <Stat label="Volume" value={fmtInt(info.volume)} />
            <Stat label="Avg Volume (3M)" value={fmtInt(info.avgVolume)} />
            {info.employees != null && (
              <Stat label="Employees" value={fmtInt(info.employees)} />
            )}
          </div>

          {/* Business summary */}
          {info.summary && (
            <div>
              <div className="mb-1 text-xs font-bold uppercase tracking-wider text-navy-400">
                About
              </div>
              <p className="text-sm leading-relaxed text-navy">{info.summary}</p>
            </div>
          )}

          {/* Links */}
          <div className="flex flex-wrap gap-2 border-t border-navy-50 pt-4 text-xs">
            <a
              href={`https://finance.yahoo.com/quote/${encodeURIComponent(info.ticker)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-navy-100 px-3 py-1.5 font-semibold text-navy hover:bg-navy-50"
            >
              <ExternalLink className="h-3 w-3" />
              Yahoo Finance
            </a>
            <a
              href={`https://www.google.com/finance/quote/${encodeURIComponent(info.ticker)}:${encodeURIComponent(info.exchange || 'NASDAQ')}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-navy-100 px-3 py-1.5 font-semibold text-navy hover:bg-navy-50"
            >
              <ExternalLink className="h-3 w-3" />
              Google Finance
            </a>
            {info.website && (
              <a
                href={safeHref(info.website)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-lg border border-navy-100 px-3 py-1.5 font-semibold text-navy hover:bg-navy-50"
              >
                <ExternalLink className="h-3 w-3" />
                Company Site
              </a>
            )}
          </div>
          <div className="text-[10px] text-navy-400">
            Market data from {info._source === 'finnhub' ? 'Finnhub' : 'Yahoo Finance'}.
            Position data from the club's Google Sheet.
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wider text-navy-400">
        {label}
      </div>
      <div className="text-sm font-semibold text-navy tabular-nums">
        {value ?? '—'}
      </div>
    </div>
  );
}
