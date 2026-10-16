// Black-Scholes-Merton for European options with a continuous dividend yield.
// Pure functions, no DOM. Inputs are plain numbers in "natural" units:
//   S spot, K strike, r risk-free rate (0.05 = 5%), q dividend yield,
//   sigma volatility (0.20 = 20%), T time to expiry in years.

export const DAYS_PER_YEAR = 365;
const SQRT_2PI = 2.5066282746310002;

/** Standard normal density. */
export function normPdf(x) {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/**
 * Standard normal CDF, double precision (Hart's rational approximation as
 * refined by Graeme West). Absolute error is around 1e-15.
 */
export function normCdf(x) {
  const a = Math.abs(x);
  let c;
  if (a > 37) {
    c = 0;
  } else {
    const e = Math.exp(-0.5 * a * a);
    if (a < 7.07106781186547) {
      let n = 3.52624965998911e-2 * a + 0.700383064443688;
      n = n * a + 6.37396220353165;
      n = n * a + 33.912866078383;
      n = n * a + 112.079291497871;
      n = n * a + 221.213596169931;
      n = n * a + 220.206867912376;
      let d = 8.83883476483184e-2 * a + 1.75566716318264;
      d = d * a + 16.064177579207;
      d = d * a + 86.7807322029461;
      d = d * a + 296.564248779674;
      d = d * a + 637.333633378831;
      d = d * a + 793.826512519948;
      d = d * a + 440.413735824752;
      c = (e * n) / d;
    } else {
      let b = a + 0.65;
      b = a + 4 / b;
      b = a + 3 / b;
      b = a + 2 / b;
      b = a + 1 / b;
      c = e / b / SQRT_2PI;
    }
  }
  return x > 0 ? 1 - c : c;
}

/** The d1 and d2 terms. Only meaningful when sigma > 0 and T > 0. */
export function d1d2({ S, K, r = 0, q = 0, sigma, T }) {
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / v;
  return { d1, d2: d1 - v };
}

/** Option value. type is 'call' or 'put'. Handles T <= 0 and sigma <= 0. */
export function bsmPrice(p, type = 'call') {
  const { S, K, r = 0, q = 0, sigma, T } = p;
  const isCall = type === 'call';
  if (T <= 0) return Math.max(isCall ? S - K : K - S, 0);
  const dq = Math.exp(-q * T);
  const df = Math.exp(-r * T);
  if (sigma <= 0) {
    const fwd = S * dq - K * df; // deterministic: value is discounted forward intrinsic
    return Math.max(isCall ? fwd : -fwd, 0);
  }
  const { d1, d2 } = d1d2(p);
  return isCall
    ? S * dq * normCdf(d1) - K * df * normCdf(d2)
    : K * df * normCdf(-d2) - S * dq * normCdf(-d1);
}

/**
 * Greeks in practical trading units:
 *   delta  per 1.00 move in spot
 *   gamma  change in delta per 1.00 move in spot
 *   vega   per 1 volatility point (0.01)
 *   theta  per calendar day
 *   rho    per 1 rate point (0.01)
 */
export function bsmGreeks(p, type = 'call') {
  const { S, K, r = 0, q = 0, sigma, T } = p;
  const isCall = type === 'call';
  const s = isCall ? 1 : -1;
  if (T <= 0) {
    const itm = isCall ? S > K : S < K;
    return { delta: itm ? s : 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
  }
  const dq = Math.exp(-q * T);
  const df = Math.exp(-r * T);
  if (sigma <= 0) {
    const fwd = S * dq - K * df;
    const itm = isCall ? fwd > 0 : fwd < 0;
    return {
      delta: itm ? s * dq : 0,
      gamma: 0,
      vega: 0,
      theta: itm ? (s * (q * S * dq - r * K * df)) / DAYS_PER_YEAR : 0,
      rho: itm ? (s * K * T * df) / 100 : 0,
    };
  }
  const { d1, d2 } = d1d2(p);
  const sqT = Math.sqrt(T);
  const pdf = normPdf(d1);
  const decay = -(S * dq * pdf * sigma) / (2 * sqT);
  const thetaYear = isCall
    ? decay - r * K * df * normCdf(d2) + q * S * dq * normCdf(d1)
    : decay + r * K * df * normCdf(-d2) - q * S * dq * normCdf(-d1);
  return {
    delta: isCall ? dq * normCdf(d1) : -dq * normCdf(-d1),
    gamma: (dq * pdf) / (S * sigma * sqT),
    vega: (S * dq * pdf * sqT) / 100,
    theta: thetaYear / DAYS_PER_YEAR,
    rho: (isCall ? K * T * df * normCdf(d2) : -K * T * df * normCdf(-d2)) / 100,
  };
}

/** Put-call parity: C - P should equal S e^{-qT} - K e^{-rT}. */
export function putCallParity(p, call, put) {
  const c = call === undefined ? bsmPrice(p, 'call') : call;
  const pu = put === undefined ? bsmPrice(p, 'put') : put;
  const lhs = c - pu;
  const rhs = p.S * Math.exp(-(p.q || 0) * p.T) - p.K * Math.exp(-(p.r || 0) * p.T);
  return { call: c, put: pu, lhs, rhs, diff: lhs - rhs };
}

/**
 * Implied volatility from a market price. Newton's method with a maintained
 * bracket: any step that leaves the bracket (or meets a vanishing vega) is
 * replaced by a bisection step, so it always converges when a solution exists.
 * Returns { vol, status, iterations, method }. status is 'ok' or a reason
 * ('invalid', 'below-intrinsic', 'at-intrinsic', 'above-max', 'no-convergence').
 */
export function impliedVol(marketPrice, p, type = 'call', opts = {}) {
  const { tol = 1e-10, maxIter = 100 } = opts;
  const { S, K, r = 0, q = 0, T } = p;
  const fail = (status) => ({ vol: NaN, status, iterations: 0, method: 'none' });
  if (![marketPrice, S, K, T].every(Number.isFinite) || S <= 0 || K <= 0 || T <= 0 || marketPrice < 0) {
    return fail('invalid');
  }
  const isCall = type === 'call';
  const floor = bsmPrice({ ...p, sigma: 0 }, type);
  const ceiling = isCall ? S * Math.exp(-q * T) : K * Math.exp(-r * T);
  if (marketPrice < floor - 1e-12) return fail('below-intrinsic');
  if (marketPrice <= floor + 1e-12) return { vol: 0, status: 'at-intrinsic', iterations: 0, method: 'none' };
  if (marketPrice >= ceiling) return fail('above-max');

  const f = (sig) => bsmPrice({ ...p, sigma: sig }, type) - marketPrice;
  let lo = 1e-6;
  let hi = 10;
  if (f(hi) < 0) return fail('above-max');
  let x = Math.sqrt((2 * Math.PI) / T) * (marketPrice / S); // Brenner-Subrahmanyam seed
  if (!Number.isFinite(x) || x <= lo || x >= hi) x = 0.2;
  let bisected = false;
  let fx = f(x);
  let i = 0;
  for (; i < maxIter; i++) {
    if (Math.abs(fx) < tol) break;
    if (fx > 0) hi = x;
    else lo = x;
    if (hi - lo < 1e-14) break;
    const vega = bsmGreeks({ ...p, sigma: x }, type).vega * 100;
    let next = vega > 1e-10 ? x - fx / vega : NaN;
    if (!(next > lo && next < hi)) {
      next = 0.5 * (lo + hi);
      bisected = true;
    }
    x = next;
    fx = f(x);
  }
  if (Math.abs(fx) > 1e-6) return { vol: x, status: 'no-convergence', iterations: i, method: 'newton+bisection' };
  return { vol: x, status: 'ok', iterations: i, method: bisected ? 'newton+bisection' : 'newton' };
}
