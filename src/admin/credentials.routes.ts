import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { encrypt } from '../security/crypto.js';
import { ValidationError, NotFoundError, ConflictError, isUniqueConstraintError } from '../errors.js';
import { invalidateAdapter } from '../routing/adapter-cache.js';
import { runCredentialConnectivityCheck } from '../health/check.js';
import { assertNonEmptyString, assertBoolean } from './validation.js';

const ADAPTER_TYPES = ['passthrough', 'anthropic_native'] as const;
type AdapterType = (typeof ADAPTER_TYPES)[number];

// 回傳給前端的安全欄位——絕對不能把 apiKeyEncrypted 吐出去。
function toSafeCredential(row: typeof schema.credentials.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    adapterType: row.adapterType,
    baseUrl: row.baseUrl ?? undefined,
    enabled: row.enabled,
    connectivityStatus: row.connectivityStatus,
    lastCheckedAt: row.lastCheckedAt ?? undefined,
    lastLatencyMs: row.lastLatencyMs ?? undefined,
    lastError: row.lastError ?? undefined,
    createdAt: row.createdAt,
  };
}

function assertAdapterType(value: unknown): AdapterType {
  if (typeof value !== 'string' || !ADAPTER_TYPES.includes(value as AdapterType)) {
    throw new ValidationError(`adapterType must be one of ${ADAPTER_TYPES.join(', ')}`);
  }
  return value as AdapterType;
}

export const credentialsRouter = Router();

credentialsRouter.get('/', (_req, res) => {
  const rows = db.select().from(schema.credentials).all();
  res.json(rows.map(toSafeCredential));
});

credentialsRouter.post('/', (req, res) => {
  const body = req.body ?? {};
  const name = assertNonEmptyString(body.name, 'name');
  const adapterType = assertAdapterType(body.adapterType);
  const baseUrl = adapterType === 'passthrough' ? assertNonEmptyString(body.baseUrl, 'baseUrl') : undefined;
  const apiKey = assertNonEmptyString(body.apiKey, 'apiKey');
  const enabled = body.enabled === undefined ? true : assertBoolean(body.enabled, 'enabled');

  const row = {
    id: randomUUID(),
    name,
    adapterType,
    baseUrl,
    apiKeyEncrypted: encrypt(apiKey),
    enabled,
    createdAt: new Date().toISOString(),
  };

  try {
    db.insert(schema.credentials).values(row).run();
  } catch (err) {
    if (isUniqueConstraintError(err, 'credentials.name')) {
      throw new ConflictError(`Credential name "${name}" already exists`);
    }
    throw err;
  }

  // 重新查一次而不是直接回傳上面組的 row：connectivityStatus 等欄位靠
  // DB 端 default 值帶出來，手動組的物件裡沒有這些欄位。
  const created = db.select().from(schema.credentials).where(eq(schema.credentials.id, row.id)).get()!;
  res.status(201).json(toSafeCredential(created));
});

credentialsRouter.patch('/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.select().from(schema.credentials).where(eq(schema.credentials.id, id)).get();
  if (!existing) throw new NotFoundError(`Credential ${id} not found`);

  const body = req.body ?? {};
  const updates: Partial<typeof schema.credentials.$inferInsert> = {};

  // @article topic:two-tier-health-check
  // code review 2026-09-21 抓到的問題：改了 adapterType/apiKey/baseUrl——
  // 連線檢查實際在測的輸入——卻沒有讓舊的 connectivityStatus 失效，畫面
  // 會一直顯示編輯前那組設定的連線結果。金鑰輪替後尤其危險：舊金鑰的
  // 「連線正常」結果會一直留著，直到有人想到要手動再測一次。這裡不主動
  // 重新送一次真的連線測試（PATCH 不該有額外的網路呼叫延遲風險），只是
  // 把狀態誠實地打回 unknown，逼使用者自己按「測試連線」拿到新答案。
  let invalidateConnectivity = false;

  if (body.name !== undefined) updates.name = assertNonEmptyString(body.name, 'name');
  if (body.adapterType !== undefined) {
    updates.adapterType = assertAdapterType(body.adapterType);
    if (updates.adapterType !== existing.adapterType) invalidateConnectivity = true;
  }
  if (body.enabled !== undefined) updates.enabled = assertBoolean(body.enabled, 'enabled');
  // apiKey 留空（undefined 或空字串）代表不更新，比照 01-config-management.md 的表單規則
  if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') {
    updates.apiKeyEncrypted = encrypt(body.apiKey);
    invalidateConnectivity = true;
  }

  // baseUrl 型別先擋掉非字串/非 null（例如物件/數字直接綁進 better-sqlite3
  // 參數會丟未捕捉的 TypeError，變成裸露的 500）；是否允許空字串留到下面
  // 依「最終 adapterType」統一判斷。
  if (body.baseUrl !== undefined) {
    if (body.baseUrl !== null && typeof body.baseUrl !== 'string') {
      throw new ValidationError('baseUrl must be a string or null');
    }
    if (body.baseUrl !== existing.baseUrl) invalidateConnectivity = true;
    updates.baseUrl = body.baseUrl;
  }

  // POST 路徑本來就要求 adapterType=passthrough 時 baseUrl 非空，但 PATCH
  // 之前完全沒有等價驗證：可以把 baseUrl 存成空字串，或把 adapterType 從
  // anthropic_native 改成 passthrough、卻沒同時給 baseUrl（沿用舊值 null）
  // ——這種壞資料在 CRUD 當下回 200，實際失敗要等到之後真的呼叫
  // getAdapter() 才爆，錯誤發生點已經跟寫入壞資料的 PATCH 請求脫勾。這裡
  // 用「這次 PATCH 決議出的最終 adapterType」統一檢查，見
  // docs/code-review-findings.md 高風險 #6。
  const finalAdapterType = updates.adapterType ?? existing.adapterType;
  if (finalAdapterType === 'passthrough') {
    const finalBaseUrl = body.baseUrl !== undefined ? body.baseUrl : existing.baseUrl;
    if (typeof finalBaseUrl !== 'string' || finalBaseUrl.trim() === '') {
      throw new ValidationError('baseUrl is required when adapterType is passthrough');
    }
  }

  if (invalidateConnectivity) {
    updates.connectivityStatus = 'unknown';
    updates.lastCheckedAt = null;
    updates.lastLatencyMs = null;
    updates.lastError = null;
  }

  try {
    db.update(schema.credentials).set(updates).where(eq(schema.credentials.id, id)).run();
  } catch (err) {
    if (isUniqueConstraintError(err, 'credentials.name')) {
      throw new ConflictError(`Credential name "${updates.name}" already exists`);
    }
    throw err;
  }

  // Credential 設定變了（尤其 api_key/adapterType/baseUrl），快取住的舊 Adapter
  // 實例就不能再用了，見 03-routing.md 已定案的 cache invalidation 規則。
  invalidateAdapter(id);

  const updated = db.select().from(schema.credentials).where(eq(schema.credentials.id, id)).get()!;
  res.json(toSafeCredential(updated));
});

// @article topic:two-tier-health-check
// 測試連線：只驗證這組 base URL + api_key 能不能連上、認證過不過，不代表
// 底下任何一個 model_deployment 的 provider_model_id 真的可用——那是
// deployments 的「手動檢查」按鈕負責的事。
credentialsRouter.post('/:id/health-check', async (req, res) => {
  const { id } = req.params;
  const result = await runCredentialConnectivityCheck(id);
  const updated = db.select().from(schema.credentials).where(eq(schema.credentials.id, id)).get()!;
  res.json({ ...result, credential: toSafeCredential(updated) });
});
