import { randomUUID } from 'node:crypto';
import { db as defaultDb, schema } from '../db/index.js';

type Db = typeof defaultDb;

export interface RequestLogEntry {
  requestId: string;
  deploymentId?: string;
  // @article topic:api-key-layer
  apiKeyId?: string;
  publicModelName: string;
  providerModelId: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  status: 'success' | 'error';
  statusCode?: number;
  errorCode?: string;
  errorMessage?: string;
  providerError?: unknown;
  latencyMs: number;
  // @article topic:fallback-routing
  // fallbackUsed：最終服務這個請求的不是候選清單裡 priority 最小那筆時為
  // true。fallbackAttempts：總共嘗試了幾筆 deployment，預設 1（沒有
  // fallback）。
  fallbackUsed?: boolean;
  fallbackAttempts?: number;
}

// 04-usage-cost.md 已定案：同步直接寫入，不用 Queue。
export function recordRequestLog(entry: RequestLogEntry, database: Db = defaultDb): void {
  database
    .insert(schema.requestLogs)
    .values({
      id: randomUUID(),
      requestId: entry.requestId,
      deploymentId: entry.deploymentId,
      apiKeyId: entry.apiKeyId,
      publicModelName: entry.publicModelName,
      providerModelId: entry.providerModelId,
      inputTokens: entry.inputTokens ?? 0,
      outputTokens: entry.outputTokens ?? 0,
      cost: entry.cost ?? 0,
      status: entry.status,
      statusCode: entry.statusCode,
      errorCode: entry.errorCode,
      errorMessage: entry.errorMessage,
      providerError: entry.providerError,
      latencyMs: entry.latencyMs,
      fallbackUsed: entry.fallbackUsed ?? false,
      fallbackAttempts: entry.fallbackAttempts ?? 1,
      createdAt: new Date().toISOString(),
    })
    .run();
}

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  inputCostPerMillion: number,
  outputCostPerMillion: number,
): number {
  // 任一輸入不是有限數字（NaN、Infinity、非數字型別）時明確拋錯，不要讓
  // NaN 靜默流進 cost 欄位——NaN 會污染 /admin/logs/summary 的 totalCost
  // 整個變成 NaN（JSON 序列化後前端拿到 null），且完全沒有錯誤訊息可查，
  // 比直接失敗更難排查。見 docs/code-review-findings.md 中風險 #13。
  for (const [name, value] of Object.entries({ inputTokens, outputTokens, inputCostPerMillion, outputCostPerMillion })) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`calculateCost() received a non-finite value for ${name}: ${value}`);
    }
  }
  return (inputTokens / 1_000_000) * inputCostPerMillion + (outputTokens / 1_000_000) * outputCostPerMillion;
}
