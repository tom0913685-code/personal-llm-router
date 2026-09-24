import type { ApiKey, Credential, CreatedApiKey, Deployment, HealthStatus, RequestLog, UsageSummary, DailyUsage } from '../types';

// 真的打 /admin/* API（見 02-gateway.md：/admin/* 與 Gateway 同一個 process）。

const BASE = '/admin';

// 2026-09-19 起：/admin/* 改用登入密碼的 session 驗證（06-site-auth.md），
// 不用再手動帶 Authorization header——同源 fetch 預設就會帶 cookie，
// Express 那邊的 requireSiteSession 直接讀 cookie 驗證。
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    // session 過期/被登出，導回登入頁而不是把「Not logged in or session
    // expired」這種訊息當一般錯誤顯示在頁面上。
    window.location.href = '/login';
    throw new Error('尚未登入或 session 已過期，正在導向登入頁');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export async function listCredentials(): Promise<Credential[]> {
  return request('/credentials');
}

// connectivityStatus/lastCheckedAt/lastLatencyMs/lastError 都是伺服器端
// 靠「測試連線」寫回的欄位，新增/編輯表單不會（也不該）送這幾個欄位。
type CredentialWritableFields = Omit<
  Credential,
  'id' | 'createdAt' | 'connectivityStatus' | 'lastCheckedAt' | 'lastLatencyMs' | 'lastError'
>;

export async function createCredential(input: CredentialWritableFields): Promise<Credential> {
  return request('/credentials', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateCredential(id: string, input: Partial<CredentialWritableFields>): Promise<Credential> {
  return request(`/credentials/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export interface CredentialHealthCheckResult {
  healthStatus: HealthStatus;
  latencyMs?: number;
  error?: string;
  credential: Credential;
}

// 對應 src/admin/credentials.routes.ts 的 POST /:id/health-check——只驗證
// 連線/認證，跟下面 Deployment 的 triggerHealthCheck()（真的打 model）是
// 分開的兩層，見 src/health/check.ts 的說明。
export async function testCredentialConnection(id: string): Promise<CredentialHealthCheckResult> {
  return request(`/credentials/${id}/health-check`, { method: 'POST' });
}

export async function listDeployments(): Promise<Deployment[]> {
  return request('/deployments');
}

export async function createDeployment(input: Omit<Deployment, 'id' | 'healthStatus'>): Promise<Deployment> {
  return request('/deployments', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateDeployment(id: string, input: Partial<Omit<Deployment, 'id'>>): Promise<Deployment> {
  return request(`/deployments/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export interface HealthCheckResult {
  healthStatus: HealthStatus;
  latencyMs?: number;
  error?: string;
  deployment: Deployment;
}

// 對應 src/admin/deployments.routes.ts 的 POST /:id/health-check，跟排程
// （src/health/scheduler.ts）共用同一套 runHealthCheck() 邏輯。
export async function triggerHealthCheck(id: string): Promise<HealthCheckResult> {
  return request(`/deployments/${id}/health-check`, { method: 'POST' });
}

export interface LogFilters {
  rangeHours?: number;
  publicModelName?: string;
  // 05-web-ui.md／04-usage-cost.md 都把 deployment 列成明細頁面的篩選維度
  // 之一，跟 status 並列——後端 GET /admin/logs 早就支援，這裡補上前端的
  // 對應參數。
  deploymentId?: string;
  status?: 'success' | 'error';
  page?: number;
  pageSize?: number;
}

function toQueryString(filters: LogFilters): string {
  const params = new URLSearchParams();
  if (filters.rangeHours !== undefined) params.set('rangeHours', String(filters.rangeHours));
  if (filters.publicModelName) params.set('publicModelName', filters.publicModelName);
  if (filters.deploymentId) params.set('deploymentId', filters.deploymentId);
  if (filters.status) params.set('status', filters.status);
  if (filters.page !== undefined) params.set('page', String(filters.page));
  if (filters.pageSize !== undefined) params.set('pageSize', String(filters.pageSize));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// 對應 src/admin/logs.routes.ts 的 GET /logs（明細列表，依時間/model/status 篩選＋分頁）。
export async function listLogs(filters: LogFilters = {}): Promise<{ items: RequestLog[]; total: number }> {
  return request(`/logs${toQueryString(filters)}`);
}

// 對應 src/admin/logs.routes.ts 的 GET /logs/summary（彙總：花費/錯誤率/fallback 觸發率）。
// rangeHours 只沿用 listLogs 的時間篩選，Dashboard 目前不需要 model/status 篩選。
export async function getUsageSummary(rangeHours?: number): Promise<UsageSummary> {
  return request(`/logs/summary${toQueryString({ rangeHours })}`);
}

// 對應 src/admin/logs.routes.ts 的 GET /logs/daily（近 N 天每日花費趨勢，範圍內沒有請求的日子補 0）。
export async function getDailyUsage(days = 7): Promise<DailyUsage> {
  return request(`/logs/daily?days=${days}`);
}

// 對應 src/admin/api-keys.routes.ts（08-api-key-layer.md）。budgetLimit/
// budgetResetDay/expiresAt/allowedModels 傳 null 表示「不限制/無到期」，
// 跟後端 assertOptional*() 系列的 undefined-vs-null 語意一致：PATCH 不帶
// 某欄位＝不更動，帶 null＝清空成不限制。
export interface ApiKeyInput {
  name: string;
  enabled?: boolean;
  budgetLimit?: number | null;
  budgetResetDay?: number | null;
  expiresAt?: string | null;
  allowedModels?: string[] | null;
}

export async function listApiKeys(): Promise<ApiKey[]> {
  return request('/api-keys');
}

export async function createApiKey(input: ApiKeyInput): Promise<CreatedApiKey> {
  return request('/api-keys', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateApiKey(id: string, input: Partial<ApiKeyInput>): Promise<ApiKey> {
  return request(`/api-keys/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export async function regenerateApiKey(id: string): Promise<CreatedApiKey> {
  return request(`/api-keys/${id}/regenerate`, { method: 'POST' });
}

export async function resetApiKeyBudget(id: string): Promise<ApiKey> {
  return request(`/api-keys/${id}/reset-budget`, { method: 'POST' });
}
