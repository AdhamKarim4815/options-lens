import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bsmPrice, bsmGreeks } from '../src/bs.js';
import {
  makeLeg, expiryPnL, todayPnL, netCost, netGreeks, analyze, sampleCurve, presetLegs, PRESETS,
} from '../src/strategy.js';

const near = (actual, expected, tol = 1e-9, msg = 'value') =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: expected ${expected}, got ${actual}`);

const MKT = { S: 100, r: 0.05, q: 0, sigma: 0.2, T: 0.5 };
const px = (K, type) => bsmPrice({ ...MKT, K }, type);
const build = (id) => presetLegs(id, MKT);

describe('legs and payoff', () => {
  test('makeLeg prices options with Black-Scholes and stock at spot', () => {
    near(makeLeg('call', 100, 1, MKT).premium, px(100, 'call'));
    const stock = makeLeg('stock', null, 100, MKT);
    assert.equal(stock.premium, 100);
    assert.equal(stock.strike, null);
  });
  test('single long call payoff at expiry', () => {
    const legs = [makeLeg('call', 100, 1, MKT)];
    const c = legs[0].premium;
    near(expiryPnL(legs, 80), -c);
    near(expiryPnL(legs, 100), -c);
    near(expiryPnL(legs, 130), 30 - c);
  });
  test('short put payoff is the mirror image of long put', () => {
    const long = [makeLeg('put', 90, 1, MKT)];
    const short = [makeLeg('put', 90, -1, MKT)];
    for (const ST of [40, 90, 120]) near(expiryPnL(long, ST), -expiryPnL(short, ST));
  });
  test('netCost is positive for debits and negative for credits', () => {
    assert.ok(netCost(build('long-call')) > 0);
    assert.ok(netCost(build('iron-condor')) < 0);
  });
  test('today value equals expiry payoff when time to expiry is zero', () => {
    const legs = build('iron-condor');
    for (const S of [60, 92, 100, 111, 150]) {
      near(todayPnL(legs, S, { ...MKT, T: 0 }), expiryPnL(legs, S), 1e-12);
    }
  });
  test('today value at entry conditions is zero P&L', () => {
    for (const p of PRESETS) near(todayPnL(presetLegs(p.id, MKT), MKT.S, MKT), 0, 1e-12, p.id);
  });
  test('today curve sits above expiry payoff for a long straddle at the strike', () => {
    const legs = build('straddle');
    assert.ok(todayPnL(legs, 100, MKT) > expiryPnL(legs, 100));
  });
  test('net Greeks add up leg by leg', () => {
    const legs = build('covered-call');
    const g = netGreeks(legs, 100, MKT);
    const call = bsmGreeks({ ...MKT, K: legs[1].strike }, 'call');
    near(g.delta, 1 - call.delta);
    near(g.gamma, -call.gamma);
    near(g.vega, -call.vega);
  });
  test('sampleCurve covers the range and includes requested kink points', () => {
    const pts = sampleCurve((x) => x * 2, 0, 10, 11, [2.5]);
    assert.equal(pts.length, 12);
    assert.equal(pts[0].x, 0);
    assert.equal(pts[pts.length - 1].x, 10);
    assert.ok(pts.some((p) => p.x === 2.5 && p.y === 5));
  });
});

describe('preset analysis (S=100, r=5%, sigma=20%, T=0.5)', () => {
  test('every preset builds distinct, positive strikes', () => {
    for (const p of PRESETS) {
      const strikes = presetLegs(p.id, MKT).filter((l) => l.type !== 'stock').map((l) => l.strike);
      assert.ok(strikes.every((k) => k > 0), p.id);
      const all = presetLegs(p.id, MKT);
      assert.equal(new Set(all.map((l) => `${l.type}@${l.strike}`)).size, all.length, p.id);
    }
    assert.equal(PRESETS.length, 8);
  });
  test('unknown preset id throws', () => {
    assert.throws(() => presetLegs('nope', MKT), /Unknown preset/);
  });
  test('long call: max loss is premium, profit unlimited, one breakeven', () => {
    const a = analyze(build('long-call'));
    const c = px(100, 'call');
    near(a.maxLoss, -c);
    assert.equal(a.maxProfit, Infinity);
    assert.equal(a.unboundedProfit, true);
    assert.equal(a.breakevens.length, 1);
    near(a.breakevens[0], 100 + c);
  });
  test('covered call: capped profit, loss if stock goes to zero', () => {
    const a = analyze(build('covered-call'));
    const c = px(105, 'call');
    near(a.maxProfit, 5 + c);
    near(a.maxLoss, -(100 - c));
    assert.equal(a.unboundedProfit, false);
    assert.equal(a.breakevens.length, 1);
    near(a.breakevens[0], 100 - c);
  });
  test('bull call spread: debit risk, width minus debit reward', () => {
    const a = analyze(build('bull-call-spread'));
    const debit = px(100, 'call') - px(110, 'call');
    near(a.maxLoss, -debit);
    near(a.maxProfit, 10 - debit);
    assert.equal(a.breakevens.length, 1);
    near(a.breakevens[0], 100 + debit);
  });
  test('protective put: loss floored, profit unlimited', () => {
    const a = analyze(build('protective-put'));
    const put = px(95, 'put');
    near(a.maxLoss, -(5 + put));
    assert.equal(a.maxProfit, Infinity);
    assert.equal(a.breakevens.length, 1);
    near(a.breakevens[0], 100 + put);
  });
  test('straddle: loss is total premium, two breakevens either side', () => {
    const a = analyze(build('straddle'));
    const prem = px(100, 'call') + px(100, 'put');
    near(a.maxLoss, -prem);
    assert.equal(a.maxProfit, Infinity);
    assert.equal(a.breakevens.length, 2);
    near(a.breakevens[0], 100 - prem);
    near(a.breakevens[1], 100 + prem);
  });
  test('strangle: loss is total premium, breakevens outside the strikes', () => {
    const a = analyze(build('strangle'));
    const prem = px(95, 'put') + px(105, 'call');
    near(a.maxLoss, -prem);
    assert.equal(a.maxProfit, Infinity);
    near(a.breakevens[0], 95 - prem);
    near(a.breakevens[1], 105 + prem);
  });
  test('iron condor: credit is the max profit, wing width less credit is the max loss', () => {
    const a = analyze(build('iron-condor'));
    const credit = -(px(90, 'put') - px(95, 'put') - px(105, 'call') + px(110, 'call'));
    assert.ok(credit > 0);
    near(a.maxProfit, credit);
    near(a.maxLoss, credit - 5);
    assert.equal(a.unboundedProfit || a.unboundedLoss, false);
    assert.equal(a.breakevens.length, 2);
    near(a.breakevens[0], 95 - credit);
    near(a.breakevens[1], 105 + credit);
  });
  test('butterfly: max profit at the middle strike, loss is the debit, two breakevens', () => {
    const a = analyze(build('butterfly'));
    const debit = px(95, 'call') - 2 * px(100, 'call') + px(105, 'call');
    near(a.maxLoss, -debit);
    near(a.maxProfit, 5 - debit);
    assert.equal(a.breakevens.length, 2);
    near(a.breakevens[0], 95 + debit);
    near(a.breakevens[1], 105 - debit);
  });
  test('breakevens are true zeros of the expiry payoff', () => {
    for (const p of PRESETS) {
      const legs = presetLegs(p.id, MKT);
      for (const be of analyze(legs).breakevens) near(expiryPnL(legs, be), 0, 1e-8, p.id);
    }
  });
  test('max profit and loss agree with a dense brute-force scan', () => {
    for (const p of PRESETS) {
      const legs = presetLegs(p.id, MKT);
      const a = analyze(legs);
      let hi = -Infinity;
      let lo = Infinity;
      for (let ST = 0; ST <= 400; ST += 0.25) {
        const v = expiryPnL(legs, ST);
        hi = Math.max(hi, v);
        lo = Math.min(lo, v);
      }
      if (a.unboundedProfit) assert.ok(a.maxProfit === Infinity && hi > 0, p.id);
      else near(a.maxProfit, hi, 1e-6, `${p.id} max profit`);
      if (a.unboundedLoss) assert.ok(a.maxLoss === -Infinity, p.id);
      else near(a.maxLoss, lo, 1e-6, `${p.id} max loss`);
    }
  });
});

describe('analysis edge cases', () => {
  test('empty position', () => {
    const a = analyze([]);
    assert.deepEqual(a.breakevens, []);
    assert.equal(a.maxProfit, 0);
    assert.equal(a.maxLoss, 0);
  });
  test('naked short call has unlimited loss', () => {
    const a = analyze([makeLeg('call', 100, -1, MKT)]);
    assert.equal(a.maxLoss, -Infinity);
    assert.equal(a.unboundedLoss, true);
    near(a.maxProfit, px(100, 'call'));
    near(a.breakevens[0], 100 + px(100, 'call'));
  });
  test('short stock alone: unlimited loss and breakeven at entry', () => {
    const a = analyze([makeLeg('stock', null, -1, MKT)]);
    assert.equal(a.maxLoss, -Infinity);
    near(a.maxProfit, 100);
    near(a.breakevens[0], 100);
  });
  test('perfectly hedged position (long stock + short stock) has no breakevens', () => {
    const a = analyze([makeLeg('stock', null, 1, MKT), makeLeg('stock', null, -1, MKT)]);
    assert.deepEqual(a.breakevens, []);
    near(a.maxProfit, 0);
    near(a.maxLoss, 0);
  });
  test('a position that never turns a profit reports a negative max profit', () => {
    const legs = [
      { type: 'call', strike: 100, qty: 1, premium: 20 },
      { type: 'call', strike: 100, qty: -1, premium: 5 },
    ];
    const a = analyze(legs);
    near(a.maxProfit, -15);
    assert.deepEqual(a.breakevens, []);
  });
});
