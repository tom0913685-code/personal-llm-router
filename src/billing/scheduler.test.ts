import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '../db/test-helpers.js';
import { runScheduledBudgetResets } from './scheduler.js';

function insertApiKey(
  db: ReturnType<typeof createTestDb>['db'],
  id: string,
  overrides: Partial<typeof schema.apiKeys.$inferInsert> = {},
): void {
  const now = new Date().toISOString();
  db.insert(schema.apiKeys)
    .values({
      id,
      name: id,
      keyHash: `hash-${id}`,
      keyPrefix: 'sk-abc1234',
      enabled: true,
      currentSpend: 5,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })
    .run();
}

test('runScheduledBudgetResets() 只掃 budgetResetDay 不是 null 的 key', () => {
  const { db } = createTestDb();
  insertApiKey(db, 'no-schedule', { budgetResetDay: null, currentSpend: 10 });
  insertApiKey(db, 'due', { budgetResetDay: 15, lastResetAt: null, currentSpend: 10 });

  runScheduledBudgetResets(db);

  const noSchedule = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, 'no-schedule')).get()!;
  const due = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, 'due')).get()!;
  assert.equal(noSchedule.currentSpend, 10, '沒設定 budgetResetDay 的 key 完全不會被排程碰到');
  assert.equal(due.currentSpend, 0, 'lastResetAt 是 null 視為一定該重置');
});

test('runScheduledBudgetResets() 還沒到重置時間的 key 維持原狀', () => {
  const { db } = createTestDb();
  const now = new Date();
  insertApiKey(db, 'not-due', { budgetResetDay: now.getUTCDate(), lastResetAt: now.toISOString(), currentSpend: 10 });

  runScheduledBudgetResets(db);

  const row = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, 'not-due')).get()!;
  assert.equal(row.currentSpend, 10);
});

test('runScheduledBudgetResets() 單筆處理失敗不影響其他筆繼續執行（比照 health/scheduler.ts 的同一套防護）', () => {
  const { db, sqlite } = createTestDb();
  insertApiKey(db, 'a', { budgetResetDay: 15, lastResetAt: null, currentSpend: 10 });
  insertApiKey(db, 'b', { budgetResetDay: 15, lastResetAt: null, currentSpend: 10 });

  // 強迫其中一筆的 UPDATE 在執行中失敗：對 key 'a' 先手動下一個
  // BEFORE UPDATE trigger，讓它一寫入就拋錯，藉此驗證迴圈不會被單筆例外
  // 中斷、其他筆仍然正常跑完。
  sqlite.exec(`
    CREATE TRIGGER fail_reset_for_a BEFORE UPDATE ON api_keys
    WHEN OLD.id = 'a'
    BEGIN
      SELECT RAISE(ABORT, 'simulated failure for row a');
    END;
  `);

  assert.doesNotThrow(() => runScheduledBudgetResets(db));

  const a = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, 'a')).get()!;
  const b = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, 'b')).get()!;
  assert.equal(a.currentSpend, 10, '這筆的重置失敗，維持原狀');
  assert.equal(b.currentSpend, 0, '另一筆沒有被拖垮，正常重置完成');
});
