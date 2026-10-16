import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normCdf, normPdf, bsmPrice, bsmGreeks, impliedVol, putCallParity, d1d2 } from '../src/bs.js';

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg || 'value'}: expected ${expected}, got ${actual} (tol ${tol})`);

const BASE = { S: 100, K: 100, r: 0.05, q: 0, sigma: 0.2, T: 1 };

describe('normal distribution', () => {
  test('CDF at known points', () => {
    near(normCdf(0), 0.5, 1e-15);
    near(normCdf(1), 0.8413447460685429, 1e-14);
    near(normCdf(-1.96), 0.024997895148220435, 1e-14);
    near(normCdf(3), 0.9986501019683699, 1e-14);
  });
  test('CDF symmetry and tails', () => {
    for (const x of [0.1, 0.7, 1.5, 2.9, 5, 9]) near(normCdf(x) + normCdf(-x), 1, 1e-14);
    assert.equal(normCdf(-40), 0);
    assert.equal(normCdf(40), 1);
  });
  test('PDF at zero and integral of the PDF matches the CDF', () => {
    near(normPdf(0), 0.3989422804014327, 1e-15);
    let area = 0;
    const h = 1e-3;
    for (let x = -8; x < 1; x += h) area += normPdf(x + h / 2) * h;
    near(area, normCdf(1), 1e-6);
  });
});

describe('Black-Scholes-Merton prices', () => {
  test('textbook reference: S=K=100, r=5%, sigma=20%, T=1', () => {
    near(bsmPrice(BASE, 'call'), 10.4506, 5e-5);
    near(bsmPrice(BASE, 'put'), 5.5735, 5e-5);
  });
  test('reference with dividend yield and out-of-the-money strike', () => {
    const p = { S: 100, K: 95, r: 0.03, q: 0.02, sigma: 0.25, T: 0.5 };
    near(bsmPrice(p, 'call'), 9.831948725700414, 1e-9);
    near(bsmPrice(p, 'put'), 4.412599613074562, 1e-9);
  });
  test('reference with short maturity and rate below dividend-free case', () => {
    const p = { S: 50, K: 55, r: 0.01, q: 0, sigma: 0.4, T: 0.25 };
    near(bsmPrice(p, 'call'), 2.185039271961795, 1e-9);
    near(bsmPrice(p, 'put'), 7.047711003822094, 1e-9);
  });
  test('d1 and d2 differ by sigma*sqrt(T)', () => {
    const { d1, d2 } = d1d2(BASE);
    near(d1 - d2, 0.2, 1e-15);
    near(d1, 0.35, 1e-12);
  });
  test('price increases with volatility for both calls and puts', () => {
    let prevC = -1;
    let prevP = -1;
    for (const sigma of [0.05, 0.1, 0.2, 0.4, 0.8]) {
      const c = bsmPrice({ ...BASE, sigma }, 'call');
      const p = bsmPrice({ ...BASE, sigma }, 'put');
      assert.ok(c > prevC && p > prevP);
      prevC = c;
      prevP = p;
    }
  });
  test('call is increasing and put decreasing in spot', () => {
    assert.ok(bsmPrice({ ...BASE, S: 105 }, 'call') > bsmPrice(BASE, 'call'));
    assert.ok(bsmPrice({ ...BASE, S: 105 }, 'put') < bsmPrice(BASE, 'put'));
  });
});

describe('put-call parity', () => {
  const cases = [
    BASE,
    { S: 100, K: 95, r: 0.03, q: 0.02, sigma: 0.25, T: 0.5 },
    { S: 37, K: 60, r: 0.0, q: 0.0, sigma: 0.9, T: 2 },
    { S: 250, K: 120, r: 0.08, q: 0.05, sigma: 0.15, T: 0.1 },
    { S: 100, K: 100, r: -0.01, q: 0, sigma: 0.3, T: 3 },
  ];
  test('C - P = S e^{-qT} - K e^{-rT} across many parameter sets', () => {
    for (const p of cases) {
      const { diff, lhs, rhs } = putCallParity(p);
      near(diff, 0, 1e-11, `parity diff for ${JSON.stringify(p)}`);
      near(lhs, rhs, 1e-11);
    }
  });
  test('a mispriced pair shows a non-zero gap', () => {
    const fair = putCallParity(BASE);
    const off = putCallParity(BASE, fair.call + 0.5, fair.put);
    near(off.diff, 0.5, 1e-12);
  });
});

describe('Greeks', () => {
  test('reference values at S=K=100, r=5%, sigma=20%, T=1', () => {
    const c = bsmGreeks(BASE, 'call');
    const p = bsmGreeks(BASE, 'put');
    near(c.delta, 0.636831, 1e-6);
    near(p.delta, -0.363169, 1e-6);
    near(c.gamma, 0.018762, 1e-6);
    near(c.vega, 0.375240, 1e-6);
    near(c.theta * 365, -6.414028, 1e-5);
    near(c.rho, 0.532325, 1e-6);
    near(p.rho, -0.418905, 1e-6);
  });
  test('call and put share gamma and vega; deltas differ by e^{-qT}', () => {
    const p = { ...BASE, q: 0.03, K: 110 };
    const c = bsmGreeks(p, 'call');
    const u = bsmGreeks(p, 'put');
    near(c.gamma, u.gamma, 1e-15);
    near(c.vega, u.vega, 1e-15);
    near(c.delta - u.delta, Math.exp(-0.03), 1e-12);
  });

  const grid = [
    { S: 100, K: 100, r: 0.05, q: 0, sigma: 0.2, T: 1 },
    { S: 90, K: 100, r: 0.02, q: 0.03, sigma: 0.35, T: 0.4 },
    { S: 120, K: 100, r: 0.04, q: 0.01, sigma: 0.15, T: 0.15 },
    { S: 60, K: 75, r: 0.0, q: 0.0, sigma: 0.5, T: 2 },
  ];
  for (const type of ['call', 'put']) {
    test(`${type}: analytic Greeks match central finite differences`, () => {
      for (const p of grid) {
        const f = (o) => bsmPrice({ ...p, ...o }, type);
        const hS = 1e-3 * p.S;
        const fdDelta = (f({ S: p.S + hS }) - f({ S: p.S - hS })) / (2 * hS);
        const fdGamma = (f({ S: p.S + hS }) - 2 * f({}) + f({ S: p.S - hS })) / (hS * hS);
        const hv = 1e-4;
        const fdVega = (f({ sigma: p.sigma + hv }) - f({ sigma: p.sigma - hv })) / (2 * hv) / 100;
        const hr = 1e-5;
        const fdRho = (f({ r: p.r + hr }) - f({ r: p.r - hr })) / (2 * hr) / 100;
        const ht = 1e-5;
        const fdTheta = (-(f({ T: p.T + ht }) - f({ T: p.T - ht })) / (2 * ht)) / 365;
        const g = bsmGreeks(p, type);
        const tag = JSON.stringify(p);
        near(g.delta, fdDelta, 1e-6, `delta ${tag}`);
        near(g.gamma, fdGamma, 1e-6, `gamma ${tag}`);
        near(g.vega, fdVega, 1e-7, `vega ${tag}`);
        near(g.rho, fdRho, 1e-7, `rho ${tag}`);
        near(g.theta, fdTheta, 1e-6, `theta ${tag}`);
      }
    });
  }
  test('call delta is within [0, 1] and put delta within [-1, 0]', () => {
    for (const S of [10, 60, 100, 160, 500]) {
      const c = bsmGreeks({ ...BASE, S }, 'call').delta;
      const p = bsmGreeks({ ...BASE, S }, 'put').delta;
      assert.ok(c >= 0 && c <= 1 && p <= 0 && p >= -1);
    }
  });
  test('gamma and vega peak near the money', () => {
    const at = (S) => bsmGreeks({ ...BASE, S }, 'call');
    assert.ok(at(100).gamma > at(70).gamma && at(100).gamma > at(140).gamma);
    assert.ok(at(100).vega > at(70).vega && at(100).vega > at(140).vega);
  });
});

describe('edge cases', () => {
  test('at expiry (T = 0) price is intrinsic value', () => {
    assert.equal(bsmPrice({ ...BASE, T: 0, S: 110 }, 'call'), 10);
    assert.equal(bsmPrice({ ...BASE, T: 0, S: 110 }, 'put'), 0);
    assert.equal(bsmPrice({ ...BASE, T: 0, S: 90 }, 'put'), 10);
  });
  test('T very small converges to intrinsic value', () => {
    near(bsmPrice({ ...BASE, T: 1e-9, S: 110 }, 'call'), 10, 1e-4);
    near(bsmPrice({ ...BASE, T: 1e-9, S: 90 }, 'call'), 0, 1e-6);
    const g = bsmGreeks({ ...BASE, T: 1e-9, S: 110 }, 'call');
    assert.ok(Number.isFinite(g.delta) && Number.isFinite(g.gamma) && Number.isFinite(g.theta));
    near(g.delta, 1, 1e-6);
  });
  test('at T = 0 Greeks are step functions with no NaN', () => {
    const g = bsmGreeks({ ...BASE, T: 0, S: 120 }, 'call');
    assert.deepEqual(g, { delta: 1, gamma: 0, vega: 0, theta: 0, rho: 0 });
    assert.equal(bsmGreeks({ ...BASE, T: 0, S: 120 }, 'put').delta, 0);
  });
  test('zero volatility prices at discounted forward intrinsic', () => {
    const p = { ...BASE, sigma: 0, S: 110 };
    near(bsmPrice(p, 'call'), 110 - 100 * Math.exp(-0.05), 1e-12);
    assert.equal(bsmPrice(p, 'put'), 0);
    assert.equal(bsmGreeks(p, 'call').vega, 0);
    assert.equal(bsmGreeks(p, 'call').delta, 1);
  });
  test('tiny volatility agrees with the zero-volatility limit', () => {
    for (const S of [80, 120]) {
      const tiny = bsmPrice({ ...BASE, S, sigma: 1e-8 }, 'call');
      near(tiny, bsmPrice({ ...BASE, S, sigma: 0 }, 'call'), 1e-6);
    }
  });
  test('deep in-the-money call is close to discounted forward minus strike', () => {
    const p = { ...BASE, S: 300 };
    near(bsmPrice(p, 'call'), 300 - 100 * Math.exp(-0.05), 1e-6);
    near(bsmGreeks(p, 'call').delta, 1, 1e-6);
  });
  test('deep out-of-the-money options are nearly worthless and never negative', () => {
    const p = { ...BASE, S: 20 };
    const c = bsmPrice(p, 'call');
    assert.ok(c >= 0 && c < 1e-9);
    assert.ok(bsmPrice({ ...BASE, S: 400 }, 'put') >= 0);
  });
  test('prices respect no-arbitrage bounds', () => {
    for (const S of [30, 80, 100, 130, 250]) {
      const p = { ...BASE, S, q: 0.02 };
      const lowerC = Math.max(S * Math.exp(-0.02) - 100 * Math.exp(-0.05), 0);
      const c = bsmPrice(p, 'call');
      assert.ok(c >= lowerC - 1e-12 && c <= S * Math.exp(-0.02) + 1e-12);
    }
  });
});

describe('implied volatility', () => {
  test('round trip recovers the volatility for calls and puts', () => {
    for (const type of ['call', 'put']) {
      for (const sigma of [0.05, 0.15, 0.2, 0.5, 1.2, 2.5]) {
        for (const K of [70, 100, 140]) {
          const p = { S: 100, K, r: 0.03, q: 0.01, T: 0.75 };
          const px = bsmPrice({ ...p, sigma }, type);
          const res = impliedVol(px, p, type);
          if (res.status !== 'ok') continue; // price so close to a bound that vega is zero
          near(bsmPrice({ ...p, sigma: res.vol }, type), px, 1e-8, `price round trip ${type} K=${K} s=${sigma}`);
          if (px > 1e-3) near(res.vol, sigma, 1e-4, `vol round trip ${type} K=${K} s=${sigma}`);
        }
      }
    }
  });
  test('solves the reference price back to 20%', () => {
    const res = impliedVol(10.450583572185565, { S: 100, K: 100, r: 0.05, T: 1 }, 'call');
    assert.equal(res.status, 'ok');
    near(res.vol, 0.2, 1e-8);
    assert.ok(res.iterations <= 10);
  });
  test('falls back to bisection when Newton cannot step safely', () => {
    const p = { S: 100, K: 200, r: 0.01, q: 0, T: 0.05 };
    const px = bsmPrice({ ...p, sigma: 0.9 }, 'call');
    const res = impliedVol(px, p, 'call');
    assert.equal(res.status, 'ok');
    near(res.vol, 0.9, 1e-4);
  });
  test('rejects prices below intrinsic value and above the upper bound', () => {
    const p = { S: 120, K: 100, r: 0.05, q: 0, T: 1 };
    assert.equal(impliedVol(5, p, 'call').status, 'below-intrinsic');
    assert.equal(impliedVol(121, p, 'call').status, 'above-max');
    assert.equal(impliedVol(101, { ...p, S: 100 }, 'put').status, 'above-max');
  });
  test('reports invalid input and a price sitting exactly at intrinsic value', () => {
    const p = { S: 100, K: 100, r: 0.05, T: 1 };
    assert.equal(impliedVol(NaN, p).status, 'invalid');
    assert.equal(impliedVol(5, { ...p, T: 0 }).status, 'invalid');
    const deep = { ...p, S: 200 };
    const floor = 200 - 100 * Math.exp(-0.05); // call lower bound is S - K e^{-rT}
    const at = impliedVol(floor, deep, 'call');
    assert.equal(at.status, 'at-intrinsic');
    assert.equal(at.vol, 0);
  });
});
