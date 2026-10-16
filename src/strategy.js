// Multi-leg option strategies: payoff at expiry, theoretical value today,
// and exact analysis (max profit, max loss, breakevens). Pure functions.
//
// A leg is { type: 'call' | 'put' | 'stock', strike, qty, premium }.
//   qty > 0 is long, qty < 0 is short. premium is the per-share entry price
//   (for stock, the entry price). All results are per share, not per contract.
import { bsmPrice, bsmGreeks } from './bs.js';

const EPS = 1e-9;

/** Build a leg, pricing its entry premium with Black-Scholes at market mkt. */
export function makeLeg(type, strike, qty, mkt) {
  if (type === 'stock') return { type, strike: null, qty, premium: mkt.S };
  return { type, strike, qty, premium: bsmPrice({ ...mkt, K: strike }, type) };
}

function intrinsic(leg, ST) {
  if (leg.type === 'stock') return ST;
  return leg.type === 'call' ? Math.max(ST - leg.strike, 0) : Math.max(leg.strike - ST, 0);
}

/** Profit or loss of the whole position if the underlying finishes at ST. */
export function expiryPnL(legs, ST) {
  let total = 0;
  for (const leg of legs) total += leg.qty * (intrinsic(leg, ST) - leg.premium);
  return total;
}

/** Profit or loss now if spot is S, using theoretical (Black-Scholes) values. */
export function todayPnL(legs, S, mkt) {
  let total = 0;
  for (const leg of legs) {
    const value = leg.type === 'stock' ? S : bsmPrice({ ...mkt, S, K: leg.strike }, leg.type);
    total += leg.qty * (value - leg.premium);
  }
  return total;
}

/** Net entry cost: positive is a debit, negative is a credit. */
export function netCost(legs) {
  return legs.reduce((sum, leg) => sum + leg.qty * leg.premium, 0);
}

/** Position Greeks at spot S (same units as bsmGreeks). */
export function netGreeks(legs, S, mkt) {
  const out = { delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
  for (const leg of legs) {
    if (leg.type === 'stock') {
      out.delta += leg.qty;
      continue;
    }
    const g = bsmGreeks({ ...mkt, S, K: leg.strike }, leg.type);
    for (const k of Object.keys(out)) out[k] += leg.qty * g[k];
  }
  return out;
}

/**
 * Exact expiry analysis. The payoff is piecewise linear with kinks at the
 * strikes (and the boundary at 0), so extremes and breakevens are found by
 * inspecting the kinks and the slope beyond the last one. No sampling.
 */
export function analyze(legs) {
  const cost = netCost(legs);
  if (!legs.length) {
    return { maxProfit: 0, maxLoss: 0, breakevens: [], unboundedProfit: false, unboundedLoss: false, netCost: 0 };
  }
  const strikes = legs.filter((l) => l.type !== 'stock').map((l) => l.strike);
  const knots = [...new Set([0, ...strikes.filter((k) => k > 0)])].sort((a, b) => a - b);
  const vals = knots.map((k) => expiryPnL(legs, k));
  const slopeInf = legs.reduce((s, l) => s + (l.type === 'put' ? 0 : l.qty), 0);

  const unboundedProfit = slopeInf > EPS;
  const unboundedLoss = slopeInf < -EPS;
  const maxProfit = unboundedProfit ? Infinity : Math.max(...vals);
  const maxLoss = unboundedLoss ? -Infinity : Math.min(...vals);

  const roots = [];
  const last = knots.length - 1;
  for (let i = 0; i <= last; i++) {
    const nearZero = Math.abs(vals[i]) <= EPS;
    const prevLive = i > 0 && Math.abs(vals[i - 1]) > EPS;
    const nextLive = i < last ? Math.abs(vals[i + 1]) > EPS : Math.abs(slopeInf) > EPS;
    if (nearZero && (prevLive || nextLive)) roots.push(knots[i]);
    if (i < last && !nearZero && Math.abs(vals[i + 1]) > EPS && vals[i] * vals[i + 1] < 0) {
      roots.push(knots[i] + ((knots[i + 1] - knots[i]) * vals[i]) / (vals[i] - vals[i + 1]));
    }
  }
  if (Math.abs(slopeInf) > EPS && Math.abs(vals[last]) > EPS) {
    const r = knots[last] - vals[last] / slopeInf;
    if (r > knots[last]) roots.push(r);
  }
  const breakevens = [];
  for (const r of roots.sort((a, b) => a - b)) {
    if (!breakevens.length || r - breakevens[breakevens.length - 1] > 1e-7) breakevens.push(r);
  }
  return { maxProfit, maxLoss, breakevens, unboundedProfit, unboundedLoss, netCost: cost };
}

/** Sample fn(x) at n evenly spaced points, also including any extra x values. */
export function sampleCurve(fn, lo, hi, n = 200, extra = []) {
  const xs = [];
  for (let i = 0; i < n; i++) xs.push(lo + ((hi - lo) * i) / (n - 1));
  for (const x of extra) if (x > lo && x < hi) xs.push(x);
  xs.sort((a, b) => a - b);
  return xs.map((x) => ({ x, y: fn(x) }));
}

/** Preset strategies. pct is the strike as a fraction of spot. */
export const PRESETS = [
  { id: 'long-call', name: 'Long call', blurb: 'Pay a premium for unlimited upside. The most you can lose is that premium.',
    legs: [{ type: 'call', pct: 1, qty: 1 }] },
  { id: 'covered-call', name: 'Covered call', blurb: 'Own the stock and sell a call above it. You collect income but give up gains above the strike.',
    legs: [{ type: 'stock', qty: 1 }, { type: 'call', pct: 1.05, qty: -1 }] },
  { id: 'bull-call-spread', name: 'Bull call spread', blurb: 'Buy a call and sell a higher one. Cheaper than a long call, with gains capped at the upper strike.',
    legs: [{ type: 'call', pct: 1, qty: 1 }, { type: 'call', pct: 1.1, qty: -1 }] },
  { id: 'protective-put', name: 'Protective put', blurb: 'Own the stock and buy a put below it. The put is insurance that sets a floor under your loss.',
    legs: [{ type: 'stock', qty: 1 }, { type: 'put', pct: 0.95, qty: 1 }] },
  { id: 'straddle', name: 'Straddle', blurb: 'Buy a call and a put at the same strike. You profit from a big move in either direction.',
    legs: [{ type: 'call', pct: 1, qty: 1 }, { type: 'put', pct: 1, qty: 1 }] },
  { id: 'strangle', name: 'Strangle', blurb: 'Buy an out-of-the-money call and put. Cheaper than a straddle, but it needs a bigger move.',
    legs: [{ type: 'put', pct: 0.95, qty: 1 }, { type: 'call', pct: 1.05, qty: 1 }] },
  { id: 'iron-condor', name: 'Iron condor', blurb: 'Sell a strangle and buy wings beyond it. You collect a credit and win if the price stays in a range.',
    legs: [{ type: 'put', pct: 0.9, qty: 1 }, { type: 'put', pct: 0.95, qty: -1 },
      { type: 'call', pct: 1.05, qty: -1 }, { type: 'call', pct: 1.1, qty: 1 }] },
  { id: 'butterfly', name: 'Butterfly', blurb: 'Buy two outer calls and sell two at the middle. A cheap bet that the price pins near the center.',
    legs: [{ type: 'call', pct: 0.95, qty: 1 }, { type: 'call', pct: 1, qty: -2 }, { type: 'call', pct: 1.05, qty: 1 }] },
];

/** Instantiate a preset around spot mkt.S, with entry premiums priced at mkt. */
export function presetLegs(id, mkt) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`Unknown preset: ${id}`);
  return preset.legs.map((spec) =>
    makeLeg(spec.type, spec.type === 'stock' ? null : Math.max(1, Math.round(mkt.S * spec.pct)), spec.qty, mkt),
  );
}
