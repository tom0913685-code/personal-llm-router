import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '../db/test-helpers.js';
import { isBudgetResetDue, resetBudgetIfDue, incrementSpend } from './budget.js';

function apiKeyRow(overrides: Partial<typeof schema.apiKeys.$inferInsert> = {}): typeof schema.apiKeys.$inferInsert {
  const now = new Date().toISOString();
  return {
    id: 'key-1',
    name: 'test-key',
    keyHash: 'hash',
    keyPrefix: 'sk-abc1234',
    enabled: true,
    currentSpend: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('isBudgetResetDue() budgetResetDay 是 null 時永遠不算該重置，不管 lastResetAt 多舊', () => {
  assert.equal(isBudgetResetDue({ budgetResetDay: null, lastResetAt: '2000-01-01T00:00:00.000Z' }), false);
  assert.equal(isBudgetResetDue({ budgetResetDay: null, lastResetAt: null }), false);
});

test('isBudgetResetDue() lastResetAt 是 null（從沒重置過）視為一定該重置', () => {
  assert.equal(isBudgetResetDue({ budgetResetDay: 15, lastResetAt: null }), true);
});

test('isBudgetResetDue() 這個月已經過了重置日：lastResetAt 在這期開始之前才算該重置', () => {
  const now = new Date('2026-09-20T00:00:00.000Z');
  assert.equal(isBudgetResetDue({ budgetResetDay: 15, lastResetAt: '2026-09-10T00:00:00.000Z' }, now), true);
  assert.equal(isBudgetResetDue({ budgetResetDay: 15, lastResetAt: '2026-09-16T00:00:00.000Z' }, now), false);
});

test('isBudgetResetDue() 這個月還沒到重置日：這期其實是從上個月的重置日開始算', () => {
  const now = new Date('2026-09-10T00:00:00.000Z'); // 還沒到 9/15
  assert.equal(isBudgetResetDue({ budgetResetDay: 15, lastResetAt: '2026-08-10T00:00:00.000Z' }, now), true);
  assert.equal(isBudgetResetDue({ budgetResetDay: 15, lastResetAt: '2026-08-20T00:00:00.000Z' }, now), false);
});

// @article topic:api-key-layer
// budget.ts 的註解特別提到：resetDay=31 在只有 28/30 天的月份要 clamp 到
// 當月最後一天，不然會變成無效日期。2026 年 2 月是平年（28 天）。
test('isBudgetResetDue() resetDay=31 在 28 天的 2 月要 clamp 成月底，不是變成無效日期', () => {
  const nowInFeb = new Date('2026-02-15T00:00:00.000Z'); // 2 月只有 28 天，還沒到「clamp 後的 28 號」
  // 這期其實是從上個月（1 月）的 31 號開始算。
  assert.equal(isBudgetResetDue({ budgetResetDay: 31, lastResetAt: '2026-01-20T00:00:00.000Z' }, nowInFeb), true);
  assert.equal(isBudgetResetDue({ budgetResetDay: 31, lastResetAt: '2026-02-01T00:00:00.000Z' }, nowInFeb), false);

  const nowAfterFebClamp = new Date('2026-02-28T00:00:00.000Z'); // 已經過了 clamp 後的月底
  assert.equal(isBudgetResetDue({ budgetResetDay: 31, lastResetAt: '2026-02-01T00:00:00.000Z' }, nowAfterFebClamp), true);
});

test('resetBudgetIfDue() 該重置時把 currentSpend 歸零、更新 lastResetAt，回傳 true', () => {
  const { db } = createTestDb();
  db.insert(schema.apiKeys)
    .values(apiKeyRow({ id: 'key-1', budgetResetDay: 15, lastResetAt: null, currentSpend: 12.5 }))
    .run();
  const row = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, 'key-1')).get()!;

  const now = new Date('2026-09-20T00:00:00.000Z');
  const didReset = resetBudgetIfDue(row, db, now);

  assert.equal(didReset, true);
  const updated = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, 'key-1')).get()!;
  assert.equal(updated.currentSpend, 0);
  assert.equal(updated.lastResetAt, now.toISOString());
});

test('resetBudgetIfDue() 還沒到重置時間就不動 currentSpend，回傳 false', () => {
  const { db } = createTestDb();
  const lastResetAt = '2026-09-16T00:00:00.000Z';
  db.insert(schema.apiKeys)
    .values(apiKeyRow({ id: 'key-1', budgetResetDay: 15, lastResetAt, currentSpend: 12.5 }))
    .run();
  const row = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, 'key-1')).get()!;

  const now = new Date('2026-09-20T00:00:00.000Z');
  const didReset = resetBudgetIfDue(row, db, now);

  assert.equal(didReset, false);
  const unchanged = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, 'key-1')).get()!;
  assert.equal(unchanged.currentSpend, 12.5);
  assert.equal(unchanged.lastResetAt, lastResetAt);
});

test('incrementSpend() 把花費累加進 currentSpend', () => {
  const { db } = createTestDb();
  db.insert(schema.apiKeys).values(apiKeyRow({ id: 'key-1', currentSpend: 1 })).run();

  incrementSpend('key-1', 0.5, db);
  incrementSpend('key-1', 0.25, db);

  const updated = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, 'key-1')).get()!;
  assert.equal(updated.currentSpend, 1.75);
});

test('incrementSpend() key 已經不存在時安全地什麼都不做，不拋例外', () => {
  const { db } = createTestDb();
  assert.doesNotThrow(() => incrementSpend('does-not-exist', 1, db));
});
