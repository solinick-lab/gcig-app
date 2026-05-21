import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRegression } from './regression.js';

// runRegression — the reusable OLS primitive that backs factor
// sensitivity v1 and any future regression analytics (rolling beta,
// per-sector decomposition, multi-factor attribution). The math is
// load-bearing and every value below is hand-computed: nothing here
// trusts the implementation to grade its own homework.

// A perfect linear: y = 1 + 2·x with zero residuals everywhere.
// Hand math: xBar=3, yBar=7, Sxx = (-2)² + (-1)² + 0 + 1² + 2² = 10,
// Sxy = (-2)(-4) + (-1)(-2) + 0 + 1·2 + 2·4 = 8+2+0+2+8 = 20, β=2,
// α = 7 - 2·3 = 1. Residuals all zero → SSres=0 → R²=1. With
// SSres exactly 0, stdErr collapses to 0; tStat is then 0 by the
// guard (we deliberately don't expose β/0). Same hand-pick the
// design doc walks through.
test('runRegression: perfect linear y = 1 + 2x yields β=2, α=1, R²=1', () => {
  const r = runRegression([3, 5, 7, 9, 11], [1, 2, 3, 4, 5]);
  assert.equal(r.n, 5);
  assert.equal(r.beta, 2);
  assert.equal(r.alpha, 1);
  assert.equal(r.rSquared, 1);
  assert.equal(r.stdErr, 0);
  assert.equal(r.tStat, 0);
});

// Imperfect linear — the canonical worked example. Every intermediate
// is hand-computed so a regression in the math (sign flip, off-by-one
// in the variance, wrong t-stat denominator) lights up.
// x=[1,2,3,4], y=[2,3,5,4]. xBar=2.5, yBar=3.5.
// Sxx = (-1.5)² + (-0.5)² + 0.5² + 1.5² = 2.25+0.25+0.25+2.25 = 5.
// Sxy = (-1.5)(-1.5) + (-0.5)(-0.5) + 0.5·1.5 + 1.5·0.5
//     = 2.25 + 0.25 + 0.75 + 0.75 = 4.0.
// β = 4/5 = 0.8. α = 3.5 - 0.8·2.5 = 1.5.
// fitted = [1.5+0.8·1, 1.5+1.6, 1.5+2.4, 1.5+3.2] = [2.3,3.1,3.9,4.7].
// residuals = [2-2.3, 3-3.1, 5-3.9, 4-4.7] = [-0.3,-0.1,1.1,-0.7].
// SSres = 0.09+0.01+1.21+0.49 = 1.80.
// Syy = (-1.5)²+(-0.5)²+1.5²+0.5² = 2.25+0.25+2.25+0.25 = 5.00.
// R² = 1 - 1.80/5.00 = 0.64.
// stdErr = sqrt(1.80/(4-2))/sqrt(5) = sqrt(0.9)/sqrt(5)
//        = 0.94868329805… / 2.23606797749…
//        ≈ 0.42426406871…
// tStat = 0.8 / 0.42426406871… ≈ 1.88561808316…
test('runRegression: imperfect linear (β=0.8, α=1.5, R²=0.64)', () => {
  const r = runRegression([2, 3, 5, 4], [1, 2, 3, 4]);
  assert.equal(r.n, 4);
  // β and α are exact ratios — assert to machine precision.
  assert.ok(Math.abs(r.beta - 0.8) < 1e-12, `beta ${r.beta}`);
  assert.ok(Math.abs(r.alpha - 1.5) < 1e-12, `alpha ${r.alpha}`);
  assert.ok(Math.abs(r.rSquared - 0.64) < 1e-12, `rSquared ${r.rSquared}`);
  // stdErr and tStat carry sqrt() so use a looser sqrt-friendly tol.
  assert.ok(
    Math.abs(r.stdErr - 0.4242640687119285) < 1e-9,
    `stdErr ${r.stdErr}`
  );
  assert.ok(
    Math.abs(r.tStat - 1.8856180831641267) < 1e-9,
    `tStat ${r.tStat}`
  );
});

// Zero variance in x — every x is identical. β is undefined; the
// primitive returns honest zero rather than blowing up with a divide.
// α collapses to yBar (the unconditional mean of y). R² is 0 because
// the regressor explains no variation.
test('runRegression: zero variance in x → β=0, α=yBar, R²=0', () => {
  const r = runRegression([1, 2, 3, 4], [2, 2, 2, 2]);
  assert.equal(r.n, 4);
  assert.equal(r.beta, 0);
  assert.equal(r.alpha, 2.5); // yBar = (1+2+3+4)/4
  assert.equal(r.rSquared, 0);
  assert.equal(r.stdErr, 0);
  assert.equal(r.tStat, 0);
});

// n < 2 — both empty and singleton inputs. Honest zeros, no throw,
// no NaN poisoning the aggregator upstream.
test('runRegression: n=0 → honest zeros', () => {
  const r = runRegression([], []);
  assert.deepEqual(r, { beta: 0, alpha: 0, rSquared: 0, n: 0, stdErr: 0, tStat: 0 });
});

test('runRegression: n=1 → honest zeros', () => {
  const r = runRegression([3], [1]);
  assert.deepEqual(r, { beta: 0, alpha: 0, rSquared: 0, n: 1, stdErr: 0, tStat: 0 });
});

// All-NaN / all-null pairs reduce n to zero after the filter. Same
// honest-zero contract — the primitive never throws.
test('runRegression: all NaN/null pairs filter out, n falls to 0', () => {
  const r = runRegression([NaN, null, undefined], [NaN, null, undefined]);
  assert.equal(r.n, 0);
  assert.equal(r.beta, 0);
  assert.equal(r.alpha, 0);
});

// Null/NaN filter test — the most important defensive case. Pairs
// where either side is missing must be dropped jointly so the
// remaining indexes still align as a regression problem.
// y=[2,3,5,4,6], x=[1,2,null,4,NaN]. Surviving pairs: (1,2),(2,3),(4,4).
// xBar=(1+2+4)/3=7/3. yBar=(2+3+4)/3=3.
// Sxx = (1-7/3)² + (2-7/3)² + (4-7/3)²
//     = (-4/3)² + (-1/3)² + (5/3)²
//     = 16/9 + 1/9 + 25/9 = 42/9 = 14/3.
// Sxy = (1-7/3)(2-3) + (2-7/3)(3-3) + (4-7/3)(4-3)
//     = (-4/3)(-1) + (-1/3)(0) + (5/3)(1)
//     = 4/3 + 0 + 5/3 = 9/3 = 3.
// β = 3 / (14/3) = 9/14 ≈ 0.642857142857…
// α = 3 - (9/14)(7/3) = 3 - 63/42 = 3 - 3/2 = 1.5.
// (Cross-check: α = yBar - β·xBar = 3 - (9/14)·(7/3) = 3 - 9/6 = 1.5. ✓)
test('runRegression: drops pairs where either side is null/NaN', () => {
  const r = runRegression([2, 3, 5, 4, 6], [1, 2, null, 4, NaN]);
  assert.equal(r.n, 3);
  assert.ok(Math.abs(r.beta - 9 / 14) < 1e-12, `beta ${r.beta}`);
  assert.ok(Math.abs(r.alpha - 1.5) < 1e-12, `alpha ${r.alpha}`);
});

// undefined entries are the same class as null/NaN: drop the pair,
// keep the regression honest on the survivors. No throw.
test('runRegression: drops pairs where either side is undefined', () => {
  const r = runRegression([1, 2, 3, undefined], [1, 2, 3, 4]);
  assert.equal(r.n, 3);
  // Surviving: (1,1),(2,2),(3,3) — perfect line y = x.
  assert.ok(Math.abs(r.beta - 1) < 1e-12);
  assert.ok(Math.abs(r.alpha) < 1e-12);
  assert.ok(Math.abs(r.rSquared - 1) < 1e-12);
});

// Mismatched array lengths are still safe: the loop iterates over
// the shorter array; the longer array's tail is ignored without
// throwing. n equals the joint surviving count.
test('runRegression: mismatched array lengths do not throw', () => {
  const r = runRegression([1, 2, 3, 4, 5], [1, 2, 3]);
  // Pairs read: (1,1), (2,2), (3,3) — perfect line.
  assert.equal(r.n, 3);
  assert.ok(Math.abs(r.beta - 1) < 1e-12);
});

// Non-array inputs (null, undefined, a string) must not throw. The
// primitive is reusable analytics infrastructure; a future caller
// that passes nothing should get an honest empty record back, not
// a crash.
test('runRegression: non-array inputs → honest zeros, no throw', () => {
  assert.doesNotThrow(() => runRegression(null, null));
  assert.doesNotThrow(() => runRegression(undefined, undefined));
  assert.doesNotThrow(() => runRegression('abc', [1, 2, 3]));
  const r = runRegression(null, null);
  assert.equal(r.n, 0);
  assert.equal(r.beta, 0);
});
