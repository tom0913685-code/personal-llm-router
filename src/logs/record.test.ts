import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost } from './record.js';

test('calculateCost() 正常計算', () => {
  // (1000/1e6)*2.5 + (500/1e6)*10 = 0.0025 + 0.005 = 0.0075
  const cost = calculateCost(1000, 500, 2.5, 10);
  assert.ok(Math.abs(cost - 0.0075) < 1e-9);
});

test('calculateCost() token 數或定價是 0 時回傳 0', () => {
  assert.equal(calculateCost(0, 0, 2.5, 10), 0);
});

for (const [label, bad] of [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
] as const) {
  test(`calculateCost() inputTokens 是 ${label} 時明確拋錯，不靜默回傳 NaN`, () => {
    assert.throws(() => calculateCost(bad, 500, 2.5, 10), /non-finite value for inputTokens/);
  });

  test(`calculateCost() 定價是 ${label} 時明確拋錯，不靜默回傳 NaN`, () => {
    assert.throws(() => calculateCost(1000, 500, bad, 10), /non-finite value for inputCostPerMillion/);
  });
}
