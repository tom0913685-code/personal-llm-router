// 對齊 docs/provider-adapter-spec.md 與 docs/requirements/ 的資料表設計。
// 之後接上真的 /admin/* API 時，這些型別應該跟後端回傳的 JSON 形狀一致。

export type AdapterType = 'passthrough' | 'anthropic_native';

export type HealthStatus = 'unknown' | 'healthy' | 'unhealthy';

// connectivityStatus 只驗證這組 base URL + api_key 能不能連上、認證過不
// 過——跟 Deployment 的 healthStatus（真的打特定 model）是兩層不同的檢
// 查，2026-09-19 使用者要求分開（見 src/health/check.ts 的說明）。
export interface Credential {
  id: string;
  name: string;
  adapterType: AdapterType;
  baseUrl?: string;
  enabled: boolean;
  connectivityStatus: HealthStatus;
  lastCheckedAt?: string;
  lastLatencyMs?: number;
  lastError?: string;
  createdAt: string;
}

export interface Deployment {
  id: string;
  credentialId: string;
  publicModelName: string;
  providerModelId: string;
  // 數字小的先試，同一個 publicModelName 可以掛多筆 deployment 依序當
  // Fallback 候選（見 docs/requirements/03-routing.md）。
  priority: number;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  enabled: boolean;
  // 是否排進排程健康檢查的掃描名單，預設 false（見
  // docs/requirements/01-config-management.md 的已定案）。
  autoHealthCheckEnabled: boolean;
  healthStatus: HealthStatus;
  lastCheckedAt?: string;
  lastLatencyMs?: number;
  lastError?: string;
  // 跟 lastCheckedAt 分開：lastCheckedAt 不分來源（手動/排程/建立時自動
  // 檢查都會更新），這個欄位只在使用者真的按「手動檢查」按鈕時更新
  // （2026-09-21，見 src/health/check.ts 的說明）。
  lastManualCheckedAt?: string;
}

export type LogStatus = 'success' | 'error';

export interface RequestLog {
  id: string;
  requestId: string;
  deploymentId?: string;
  publicModelName: string;
  providerModelId: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  status: LogStatus;
  statusCode?: number;
  errorCode?: string;
  errorMessage?: string;
  providerError?: unknown;
  latencyMs: number;
  createdAt: string;
}

export interface UsageSummary {
  totalCost: number;
  totalRequests: number;
  errorRate: number;
  // 依時間區間統計 fallbackUsed=true 的佔比，讓使用者知道哪個 model 常常
  // 需要靠備援才能成功（見 docs/requirements/04-usage-cost.md 已定案）。
  fallbackRate: number;
  // 分組 key 是 deploymentId（可能是 null——deployment 被刪除的舊 log，
  // schema 用 ON DELETE SET NULL），不是 publicModelName：同一個 model 底
  // 下的 primary/fallback 多筆 deployment 要能分開顯示，不能被合併成一列
  // （見 src/admin/logs.routes.ts 的說明）。
  byDeployment: { deploymentId: string | null; publicModelName: string; cost: number; requests: number }[];
}

export interface DailyUsagePoint {
  date: string; // YYYY-MM-DD（UTC 曆日）
  cost: number;
  requests: number;
}

export interface DailyUsage {
  days: DailyUsagePoint[];
}

// 對齊 docs/requirements/08-api-key-layer.md 的 api_keys 表——後端
// toSafeApiKey() 絕對不會回傳 keyHash，這個型別跟著拿掉。
export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  allowedModels: string[] | null;
  budgetLimit: number | null;
  currentSpend: number;
  budgetResetDay: number | null;
  lastResetAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// 新增／重新產生時，後端多回傳一次性的明文 key（plaintextKey）——只有這
// 一次回應會看到，之後 GET /admin/api-keys 只會回 keyPrefix。
export interface CreatedApiKey extends ApiKey {
  plaintextKey: string;
}
