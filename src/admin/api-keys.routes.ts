import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { generateApiKey } from '../security/api-key.js';
import { NotFoundError } from '../errors.js';
import {
  assertNonEmptyString,
  assertBoolean,
  assertNumberOrDefault,
  assertBudgetResetDay,
  assertStringArray,
  assertIsoDateString,
} from './validation.js';

// 回傳給前端的安全欄位——絕對不能把 keyHash 吐出去（那是唯一能拿去比對
// 這把 key 的資料，雖然是雜湊不是明文，但沒有理由讓它離開後端）。
function toSafeApiKey(row: typeof schema.apiKeys.$inferSelect) {
  const { keyHash, ...safe } = row;
  return safe;
}

function assertOptionalBudgetLimit(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return assertNumberOrDefault(value, 'budgetLimit', 0);
}

function assertOptionalBudgetResetDay(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return assertBudgetResetDay(value);
}

function assertOptionalIsoString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return assertIsoDateString(value, field);
}

function assertOptionalAllowedModels(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  return assertStringArray(value, 'allowedModels');
}

export const apiKeysRouter = Router();

apiKeysRouter.get('/', (_req, res) => {
  const rows = db.select().from(schema.apiKeys).all();
  res.json(rows.map(toSafeApiKey));
});

// @article topic:api-key-layer
// 新增時明文 key 只在這次回應裡出現一次（plaintextKey 欄位），之後畫面上
// 只會看到 key_prefix——跟 GitHub PAT/Stripe key 那種「建立時顯示一次，
// 關掉就再也看不到」的慣例一致。
apiKeysRouter.post('/', (req, res) => {
  const body = req.body ?? {};
  const name = assertNonEmptyString(body.name, 'name');
  const enabled = body.enabled === undefined ? true : assertBoolean(body.enabled, 'enabled');
  const budgetLimit = assertOptionalBudgetLimit(body.budgetLimit);
  const budgetResetDay = assertOptionalBudgetResetDay(body.budgetResetDay);
  const expiresAt = assertOptionalIsoString(body.expiresAt, 'expiresAt');
  const allowedModels = assertOptionalAllowedModels(body.allowedModels);

  const generated = generateApiKey();
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    name,
    keyHash: generated.hash,
    keyPrefix: generated.prefix,
    enabled,
    allowedModels,
    budgetLimit,
    currentSpend: 0,
    budgetResetDay,
    lastResetAt: null,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(schema.apiKeys).values(row).run();

  res.status(201).json({ ...toSafeApiKey(row), plaintextKey: generated.plaintext });
});

apiKeysRouter.patch('/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get();
  if (!existing) throw new NotFoundError(`API key ${id} not found`);

  const body = req.body ?? {};
  const updates: Partial<typeof schema.apiKeys.$inferInsert> = { updatedAt: new Date().toISOString() };

  if (body.name !== undefined) updates.name = assertNonEmptyString(body.name, 'name');
  if (body.enabled !== undefined) updates.enabled = assertBoolean(body.enabled, 'enabled');
  if (body.budgetLimit !== undefined) updates.budgetLimit = assertOptionalBudgetLimit(body.budgetLimit);
  if (body.budgetResetDay !== undefined) updates.budgetResetDay = assertOptionalBudgetResetDay(body.budgetResetDay);
  if (body.expiresAt !== undefined) updates.expiresAt = assertOptionalIsoString(body.expiresAt, 'expiresAt');
  if (body.allowedModels !== undefined) updates.allowedModels = assertOptionalAllowedModels(body.allowedModels);

  db.update(schema.apiKeys).set(updates).where(eq(schema.apiKeys.id, id)).run();

  const updated = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get()!;
  res.json(toSafeApiKey(updated));
});

// 重新產生：同一筆記錄的 id/name/額度設定都不變，只換 keyHash/keyPrefix，
// 明文一樣只顯示這一次。
apiKeysRouter.post('/:id/regenerate', (req, res) => {
  const { id } = req.params;
  const existing = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get();
  if (!existing) throw new NotFoundError(`API key ${id} not found`);

  const generated = generateApiKey();
  const now = new Date().toISOString();
  db.update(schema.apiKeys)
    .set({ keyHash: generated.hash, keyPrefix: generated.prefix, updatedAt: now })
    .where(eq(schema.apiKeys.id, id))
    .run();

  const updated = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get()!;
  res.json({ ...toSafeApiKey(updated), plaintextKey: generated.plaintext });
});

// 立即重置：無條件重置（不像 requireGatewayKey 的惰性重置要先判斷
// isBudgetResetDue()），使用者按下按鈕就是要現在重置。
apiKeysRouter.post('/:id/reset-budget', (req, res) => {
  const { id } = req.params;
  const existing = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get();
  if (!existing) throw new NotFoundError(`API key ${id} not found`);

  const now = new Date().toISOString();
  db.update(schema.apiKeys).set({ currentSpend: 0, lastResetAt: now, updatedAt: now }).where(eq(schema.apiKeys.id, id)).run();

  const updated = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).get()!;
  res.json(toSafeApiKey(updated));
});
