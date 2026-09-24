import { eq } from 'drizzle-orm';
import { db as defaultDb, schema } from '../db/index.js';
import { getAdapter } from '../routing/adapter-cache.js';
import { NotFoundError } from '../errors.js';

type Db = typeof defaultDb;

export interface HealthCheckResult {
  healthStatus: 'healthy' | 'unhealthy';
  latencyMs?: number;
  error?: string;
}

// @article topic:two-tier-health-check
// 這把 chat() 打的是「這個 deployment 實際要用的 provider_model_id」。
// 故意不帶 maxTokens：原本想壓一個很小的值（5）省成本，實測直接踩雷——
// PassthroughAdapter 固定送 `max_tokens` 這個欄位名稱，但新一代 OpenAI
// 相容 model（包括這個專案主要在用的 gpt-5.1）已經改用
// `max_completion_tokens`，帶 `max_tokens` 直接被上游拒絕（400
// unsupported_parameter），會把「這個 model 明明正常」誤判成 unhealthy
// ——比原本要修的「假 model 卻顯示 healthy」問題更糟。不帶這個欄位，
// `JSON.stringify` 會整個省略掉，讓上游用它自己的預設值，兩種參數命名
// 都不會踩到。
const MODEL_CHECK_MESSAGES = [{ role: 'user' as const, content: 'ping' }];

// @article topic:two-tier-health-check
// Deployment 層的健康檢查：真的送一次最小化的 chat() 請求，用這個
// deployment 設定的 provider_model_id——才能抓到「credential 連線正常，
// 但這個 model 名稱打錯/不存在/帳號無權限」這種只驗連線測不出來的情況
// （使用者 2026-09-19 實際踩到的問題）。三個觸發點共用同一套邏輯：
// (1) 「手動檢查」按鈕、(2) 新增 deployment 時的初次自動檢查、
// (3) 排程（2026-09-21 起排程也改用這個深層檢查，不再是只驗連線的輕量
// ping——使用者明確要求，代價是排程會持續產生真的呼叫 model 的 token
// 成本）。
//
// manual 只在「使用者真的按下手動檢查按鈕」時傳 true，額外寫回
// lastManualCheckedAt——跟 lastCheckedAt（不分來源、最近一次檢查的時間）
// 分開追蹤，讓畫面能回答「我自己上次確認是什麼時候」，不會被排程/建立
// 時的自動檢查蓋過去。
export async function runDeploymentModelCheck(
  deploymentId: string,
  database: Db = defaultDb,
  options: { manual?: boolean } = {},
): Promise<HealthCheckResult> {
  const deployment = database.select().from(schema.modelDeployments).where(eq(schema.modelDeployments.id, deploymentId)).get();
  if (!deployment) {
    throw new NotFoundError(`Deployment ${deploymentId} not found`);
  }

  const credential = database.select().from(schema.credentials).where(eq(schema.credentials.id, deployment.credentialId)).get();
  if (!credential) {
    throw new NotFoundError(`Deployment ${deploymentId} references a missing credential`);
  }

  let result: HealthCheckResult;
  const start = Date.now();
  try {
    const adapter = getAdapter(credential.id, database);
    await adapter.chat({
      model: deployment.providerModelId,
      messages: MODEL_CHECK_MESSAGES,
    });
    result = { healthStatus: 'healthy', latencyMs: Date.now() - start };
  } catch (err) {
    result = { healthStatus: 'unhealthy', error: err instanceof Error ? err.message : String(err) };
  }

  const now = new Date().toISOString();
  database
    .update(schema.modelDeployments)
    .set({
      healthStatus: result.healthStatus,
      lastCheckedAt: now,
      lastLatencyMs: result.latencyMs ?? null,
      lastError: result.error ?? null,
      ...(options.manual ? { lastManualCheckedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(schema.modelDeployments.id, deploymentId))
    .run();

  return result;
}

// @article topic:two-tier-health-check
// Credential 層的連線檢查：只驗證這組 base URL + api_key 能不能連上、
// 認證過不過（打 adapter.ping()），不代表底下任何一個 Deployment 的
// provider_model_id 真的可用——那是 runDeploymentModelCheck() 的事。寫回
// credentials 表自己的欄位，跟 model_deployments 的健康欄位分開存（見
// schema.ts 的說明）。給 Credentials 頁面的「測試連線」按鈕用，目前沒有
// 排程（credentials 表沒有對應的 auto-check 開關）。
export async function runCredentialConnectivityCheck(credentialId: string, database: Db = defaultDb): Promise<HealthCheckResult> {
  const credential = database.select().from(schema.credentials).where(eq(schema.credentials.id, credentialId)).get();
  if (!credential) {
    throw new NotFoundError(`Credential ${credentialId} not found`);
  }

  let result: HealthCheckResult;
  try {
    const adapter = getAdapter(credential.id, database);
    const { latencyMs } = await adapter.ping();
    result = { healthStatus: 'healthy', latencyMs };
  } catch (err) {
    result = { healthStatus: 'unhealthy', error: err instanceof Error ? err.message : String(err) };
  }

  const now = new Date().toISOString();
  database
    .update(schema.credentials)
    .set({
      connectivityStatus: result.healthStatus,
      lastCheckedAt: now,
      lastLatencyMs: result.latencyMs ?? null,
      lastError: result.error ?? null,
    })
    .where(eq(schema.credentials.id, credentialId))
    .run();

  return result;
}
