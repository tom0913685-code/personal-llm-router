import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { ValidationError, NotFoundError, ConflictError, isUniqueConstraintError } from '../errors.js';
import { runDeploymentModelCheck } from '../health/check.js';
import { assertNonEmptyString, assertBoolean, assertNumberOrDefault, assertIntegerOrDefault } from './validation.js';

export const deploymentsRouter = Router();

// @article topic:two-tier-health-check
// code review 2026-09-21 抓到的問題：建立時原本無條件 await 真的 chat()
// 檢查，上游慢的話「新增 Deployment」對話框最差要卡到 REQUEST_TIMEOUT_MS
// （30 秒），使用者容易以為畫面凍住。這裡改成只等一個短暫上限——多數
// provider 對一句「ping」的回應遠低於這個時間，等得到就回傳最新結果；
// 等不到就先用目前的（unknown）狀態回應，檢查本身繼續在背景跑完、寫回
// DB，只是這次回應不會反映最新結果，使用者之後重新整理/再次查看就會看
// 到（runDeploymentModelCheck 內部已經把 adapter 的錯誤都接住轉成
// unhealthy，不會外洩成未處理的 rejection）。
const CREATE_HEALTH_CHECK_TIMEOUT_MS = 8_000;

// 用普通 Promise.race([promise, timeoutPromise]) 的話，輸掉的那個
// setTimeout 不會被清掉，會一直掛在 event loop 上直到自然到期——對單一
// 請求不痛不癢，但測試檔案密集建立多筆 deployment 時，累積的 timer 會
// 讓整個測試程序拖到那幾秒才真正結束。這裡手動清掉贏家決定後另一邊的
// timer，避免這個累積效應。
function raceWithTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

deploymentsRouter.get('/', (_req, res) => {
  const rows = db.select().from(schema.modelDeployments).all();
  res.json(rows);
});

// @article topic:two-tier-health-check
// 建立時就送一次真的 chat() 檢查（不是排程那種輕量 ping）——使用者
// 2026-09-19 要求：不用等到有人手動點檢查，或等到真的請求失敗才發現
// provider_model_id 打錯/不存在，新增當下就給明確的健康狀態回饋。這個
// 檢查失敗不會擋掉新增（deployment 還是會建立，只是健康狀態會是
// unhealthy），失敗原因也照樣寫進 lastError。
deploymentsRouter.post('/', async (req, res) => {
  const body = req.body ?? {};
  const credentialId = assertNonEmptyString(body.credentialId, 'credentialId');
  const publicModelName = assertNonEmptyString(body.publicModelName, 'publicModelName');
  const providerModelId = assertNonEmptyString(body.providerModelId, 'providerModelId');
  // @article topic:fallback-routing
  // priority 預設 0（沒特別設定就是唯一/最優先的候選）。
  const priority = assertIntegerOrDefault(body.priority, 'priority', 0);
  const inputCostPerMillion = assertNumberOrDefault(body.inputCostPerMillion, 'inputCostPerMillion', 0);
  const outputCostPerMillion = assertNumberOrDefault(body.outputCostPerMillion, 'outputCostPerMillion', 0);
  const enabled = body.enabled === undefined ? true : assertBoolean(body.enabled, 'enabled');
  const autoHealthCheckEnabled =
    body.autoHealthCheckEnabled === undefined ? false : assertBoolean(body.autoHealthCheckEnabled, 'autoHealthCheckEnabled');

  const credential = db.select().from(schema.credentials).where(eq(schema.credentials.id, credentialId)).get();
  if (!credential) throw new ValidationError(`credentialId "${credentialId}" does not reference an existing credential`);

  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    credentialId,
    publicModelName,
    providerModelId,
    priority,
    inputCostPerMillion,
    outputCostPerMillion,
    enabled,
    autoHealthCheckEnabled,
    healthStatus: 'unknown' as const,
    createdAt: now,
    updatedAt: now,
  };

  try {
    db.insert(schema.modelDeployments).values(row).run();
  } catch (err) {
    if (isUniqueConstraintError(err, 'model_deployments.public_model_name')) {
      throw new ConflictError(`Model "${publicModelName}" already has a deployment at priority ${priority}`);
    }
    throw err;
  }

  await raceWithTimeout(runDeploymentModelCheck(row.id), CREATE_HEALTH_CHECK_TIMEOUT_MS);
  const created = db.select().from(schema.modelDeployments).where(eq(schema.modelDeployments.id, row.id)).get()!;
  res.status(201).json(created);
});

deploymentsRouter.patch('/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.select().from(schema.modelDeployments).where(eq(schema.modelDeployments.id, id)).get();
  if (!existing) throw new NotFoundError(`Deployment ${id} not found`);

  const body = req.body ?? {};
  const updates: Partial<typeof schema.modelDeployments.$inferInsert> = { updatedAt: new Date().toISOString() };

  // @article topic:two-tier-health-check
  // code review 2026-09-21 抓到的問題：改了 credentialId 或 providerModelId
  // ——健康檢查實際在測的兩個輸入——卻沒有讓舊的檢查結果失效，畫面會一
  // 直顯示編輯前那組設定的健康狀態，使用者很容易誤以為「改了但沒生效」。
  // 這裡不主動重新送一次真的檢查（PATCH 不該有跟建立一樣的延遲風險），
  // 只是把狀態誠實地打回 unknown，逼使用者自己按「手動檢查」拿到新答案。
  let invalidateHealthCheck = false;

  if (body.credentialId !== undefined) {
    const credentialId = assertNonEmptyString(body.credentialId, 'credentialId');
    const credential = db.select().from(schema.credentials).where(eq(schema.credentials.id, credentialId)).get();
    if (!credential) throw new ValidationError(`credentialId "${credentialId}" does not reference an existing credential`);
    if (credentialId !== existing.credentialId) invalidateHealthCheck = true;
    updates.credentialId = credentialId;
  }
  if (body.publicModelName !== undefined) updates.publicModelName = assertNonEmptyString(body.publicModelName, 'publicModelName');
  if (body.providerModelId !== undefined) {
    const providerModelId = assertNonEmptyString(body.providerModelId, 'providerModelId');
    if (providerModelId !== existing.providerModelId) invalidateHealthCheck = true;
    updates.providerModelId = providerModelId;
  }
  if (body.priority !== undefined) updates.priority = assertIntegerOrDefault(body.priority, 'priority', 0);
  if (body.inputCostPerMillion !== undefined) updates.inputCostPerMillion = assertNumberOrDefault(body.inputCostPerMillion, 'inputCostPerMillion', 0);
  if (body.outputCostPerMillion !== undefined) updates.outputCostPerMillion = assertNumberOrDefault(body.outputCostPerMillion, 'outputCostPerMillion', 0);
  if (body.enabled !== undefined) updates.enabled = assertBoolean(body.enabled, 'enabled');
  if (body.autoHealthCheckEnabled !== undefined) updates.autoHealthCheckEnabled = assertBoolean(body.autoHealthCheckEnabled, 'autoHealthCheckEnabled');

  if (invalidateHealthCheck) {
    updates.healthStatus = 'unknown';
    updates.lastCheckedAt = null;
    updates.lastLatencyMs = null;
    updates.lastError = null;
    updates.lastManualCheckedAt = null;
  }

  try {
    db.update(schema.modelDeployments).set(updates).where(eq(schema.modelDeployments.id, id)).run();
  } catch (err) {
    if (isUniqueConstraintError(err, 'model_deployments.public_model_name')) {
      const name = updates.publicModelName ?? existing.publicModelName;
      const priority = updates.priority ?? existing.priority;
      throw new ConflictError(`Model "${name}" already has a deployment at priority ${priority}`);
    }
    throw err;
  }

  const updated = db.select().from(schema.modelDeployments).where(eq(schema.modelDeployments.id, id)).get()!;
  res.json(updated);
});

// @article topic:two-tier-health-check
// 手動健康檢查用 runDeploymentModelCheck()（真的打一次 model）——使用者
// 按這個按鈕要的是「這個 model 現在到底能不能用」的明確答案，不是連線
// 有沒有通。manual:true 額外寫回 lastManualCheckedAt，跟排程/建立時的自
// 動檢查分開追蹤「使用者自己上次確認是什麼時候」。
deploymentsRouter.post('/:id/health-check', async (req, res) => {
  const { id } = req.params;
  const result = await runDeploymentModelCheck(id, db, { manual: true });
  const updated = db.select().from(schema.modelDeployments).where(eq(schema.modelDeployments.id, id)).get()!;
  res.json({ ...result, deployment: updated });
});
