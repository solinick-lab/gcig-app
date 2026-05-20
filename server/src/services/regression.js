// runRegression — the reusable OLS primitive that backs factor
// sensitivity v1 and (by design) any future regression analytics:
// rolling beta, per-sector decomposition, multi-factor attribution.
// Pure, deterministic, hand-computable, never throws. The math is
// load-bearing — the panel reads downstream numbers as "if 10Y moves
// 50bps, your book ~Z%" — so the contract here is small and exact.
//
// Inputs are two arrays the caller has already aligned by date. We do
// the joint null/NaN/undefined filter here defensively (one bad bar in
// either series upstream should never poison the regression) and
// regress the dependent (y) on the regressor (x). Output mirrors what
// a Python/R OLS would surface: β, α, R², n, and the standard error
// + t-statistic on β with the naive (non-HAC) variance formula. The
// design doc disclosed in the panel footer that we don't correct for
// autocorrelation; this primitive is intentionally simple.
//
// Edge cases collapse to honest zeros rather than NaN — the panel
// reads zeros as "regression not informative" and renders muted; NaN
// would propagate into the portfolio-β aggregator and corrupt the
// scenario preview silently.

export function runRegression(yReturns, xReturns) {
  // Defensive: any non-array (null, undefined, a string) becomes an
  // empty list. The primitive never throws; the only signal of a
  // degraded input is n=0 on the way out.
  const yArr = Array.isArray(yReturns) ? yReturns : [];
  const xArr = Array.isArray(xReturns) ? xReturns : [];

  // Joint filter: a pair is kept only when BOTH sides are finite.
  // null / undefined / NaN on either side drops the whole pair so the
  // surviving x[i] and y[i] still line up index-for-index downstream.
  const xs = [];
  const ys = [];
  const len = Math.min(xArr.length, yArr.length);
  for (let i = 0; i < len; i++) {
    const xv = xArr[i];
    const yv = yArr[i];
    if (
      xv == null ||
      yv == null ||
      typeof xv !== 'number' ||
      typeof yv !== 'number' ||
      !Number.isFinite(xv) ||
      !Number.isFinite(yv)
    ) {
      continue;
    }
    xs.push(xv);
    ys.push(yv);
  }

  const n = xs.length;
  if (n < 2) {
    return { beta: 0, alpha: 0, rSquared: 0, n, stdErr: 0, tStat: 0 };
  }

  // Means.
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
  }
  const xBar = sumX / n;
  const yBar = sumY / n;

  // Cross-products. Sxx = Σ(x-x̄)², Sxy = Σ(x-x̄)(y-ȳ),
  // Syy = Σ(y-ȳ)² (= SStot, the total variation we'll decompose).
  let Sxx = 0;
  let Sxy = 0;
  let Syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xBar;
    const dy = ys[i] - yBar;
    Sxx += dx * dx;
    Sxy += dx * dy;
    Syy += dy * dy;
  }

  // No variation in x → β is undefined (slope of a vertical cloud).
  // We collapse honestly: β = 0, α = yBar (the unconditional mean),
  // R² = 0. The panel still has a row for this factor; the reader
  // sees "no sensitivity" rather than a fake number.
  if (Sxx === 0) {
    return { beta: 0, alpha: yBar, rSquared: 0, n, stdErr: 0, tStat: 0 };
  }

  const beta = Sxy / Sxx;
  const alpha = yBar - beta * xBar;

  // SSres = Σ(y - (α + β·x))². The closed-form identity
  // SSres = Syy - β·Sxy is faster, but the explicit residual loop is
  // worth the few extra adds — it keeps the math hand-checkable and
  // doesn't drift on near-collinear inputs.
  let SSres = 0;
  for (let i = 0; i < n; i++) {
    const fitted = alpha + beta * xs[i];
    const resid = ys[i] - fitted;
    SSres += resid * resid;
  }

  // R² = 1 - SSres/Syy. Syy=0 means y is a flat line → the model
  // explained nothing because there was nothing to explain; honest 0.
  const rSquared = Syy === 0 ? 0 : 1 - SSres / Syy;

  // Naive (non-HAC) standard error on β. n<3 has no degrees of
  // freedom left → 0 honestly. The footer discloses this is the
  // unadjusted SE; HAC/Newey-West is a research follow-up.
  const stdErr =
    n < 3 ? 0 : Math.sqrt(SSres / (n - 2)) / Math.sqrt(Sxx);

  // tStat: β / SE(β). Zero SE (a perfect fit or degenerate sample)
  // would divide by zero — degrade to 0 honestly rather than emit
  // Infinity, which corrupts every downstream aggregator.
  const tStat = stdErr === 0 ? 0 : beta / stdErr;

  return { beta, alpha, rSquared, n, stdErr, tStat };
}
