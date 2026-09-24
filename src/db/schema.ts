import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// @article topic:model-deployment-schema
// credentials（連線設定）+ model_deployments（model 名稱對應/定價/健康狀態）
// 兩張正規化的表，而非單一張塞陣列欄位的 providers 表——一張 credential
// 底下可能對應多個 model，各自有不同定價/健康狀態，拆表是「這筆資料的
// 自然粒度」這個正規化問題的具體案例。對齊 docs/provider-adapter-spec.md
// 與 docs/requirements/ 的資料表設計，三張表放同一個 SQLite 檔案（見
// 04-usage-cost.md 已定案）。見 docs/article-notes.md。

// @article topic:two-tier-health-check
// 健康檢查拆兩層（2026-09-19 使用者要求）：這裡的 connectivityStatus 等
// 欄位只驗證「這組 base URL + api_key 能不能連上、認證過不過」，不代表
// 底下任何一個 model_deployments 的 provider_model_id 真的可推論——那是
// model_deployments 自己的 healthStatus 負責的事（真的送一次最小化 chat
// 請求），兩層欄位刻意分開存，不共用同一組欄位。
export const credentials = sqliteTable('credentials', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  adapterType: text('adapter_type', { enum: ['passthrough', 'anthropic_native'] }).notNull(),
  baseUrl: text('base_url'),
  apiKeyEncrypted: text('api_key_encrypted').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  connectivityStatus: text('connectivity_status', { enum: ['unknown', 'healthy', 'unhealthy'] })
    .notNull()
    .default('unknown'),
  lastCheckedAt: text('last_checked_at'),
  lastLatencyMs: integer('last_latency_ms'),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
});

// @article topic:fallback-routing
// public_model_name 原本是單獨 UNIQUE（一個名稱只能對應一筆 deployment），
// 結構性地排除了 Fallback。改成複合唯一索引 (publicModelName, priority)，
// 讓同一個名稱可以掛多筆 deployment 依序當備援——priority 數字小的先試。
// 這個決定的來龍去脈見 docs/article-notes.md 的「Fallback」主題。
export const modelDeployments = sqliteTable(
  'model_deployments',
  {
    id: text('id').primaryKey(),
    credentialId: text('credential_id')
      .notNull()
      .references(() => credentials.id),
    publicModelName: text('public_model_name').notNull(),
    providerModelId: text('provider_model_id').notNull(),
    priority: integer('priority').notNull().default(0),
    inputCostPerMillion: real('input_cost_per_million').notNull().default(0),
    outputCostPerMillion: real('output_cost_per_million').notNull().default(0),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    // @article topic:health-check-design
    // 預設 false：排程健康檢查只掃「使用者自己選要排程」的 deployment，
    // 不是全部 provider 定期自動檢查（雲端 model 呼叫有成本）。
    // @article topic:two-tier-health-check
    // 2026-09-21 修訂：排程原本只做輕量的 credential 連線探測，使用者
    // 要求改成排程也跑真的 model 檢查（runDeploymentModelCheck），跟手動
    // 「手動檢查」按鈕、建立 deployment 時的初次自動檢查共用同一套深層
    // 檢查邏輯——三者都寫回下面的 healthStatus/lastCheckedAt 等欄位，
    // healthStatus 反映的是「最近一次檢查」的結果，不分來源。開這個開關
    // 代表接受排程會持續產生真的呼叫 model 的 token 成本，不是原本輕量
    // ping 的成本量級。
    autoHealthCheckEnabled: integer('auto_health_check_enabled', { mode: 'boolean' }).notNull().default(false),
    healthStatus: text('health_status', { enum: ['unknown', 'healthy', 'unhealthy'] })
      .notNull()
      .default('unknown'),
    lastCheckedAt: text('last_checked_at'),
    lastLatencyMs: integer('last_latency_ms'),
    lastError: text('last_error'),
    // @article topic:two-tier-health-check
    // 跟上面的 lastCheckedAt 分開存：lastCheckedAt 是「最近一次不管哪個
    // 來源」的檢查時間，這個欄位只在使用者真的按「手動檢查」按鈕時更新，
    // 讓畫面能回答「我自己上次確認是什麼時候」，跟排程/建立時自動觸發的
    // 檢查分開追蹤。
    lastManualCheckedAt: text('last_manual_checked_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('model_deployments_public_model_name_priority_idx').on(table.publicModelName, table.priority),
    index('model_deployments_public_model_name_idx').on(table.publicModelName),
  ],
);

// @article topic:api-key-layer
// 取代原本單一固定的 ROUTER_API_KEY——這批 key 專門保護 /v1/*（Gateway），
// 讓使用者可以把 key 放進自己的程式碼裡也不擔心外流：外流只影響單一把
// key 的額度跟權限，可以單獨停用/重新產生，不影響其他 key。key_hash 只存
// SHA-256 雜湊（不可逆），這把 key 從頭到尾只需要拿來比對，跟 Credential
// 的 api_key（之後還要解密拿去打上游）性質不同，不能照抄同一套加密方案。
// 見 docs/requirements/08-api-key-layer.md。
export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  // null = 不限制，可以打任何啟用中的 public_model_name；非 null = 白名單。
  allowedModels: text('allowed_models', { mode: 'json' }).$type<string[] | null>(),
  budgetLimit: real('budget_limit'),
  currentSpend: real('current_spend').notNull().default(0),
  budgetResetDay: integer('budget_reset_day'),
  lastResetAt: text('last_reset_at'),
  expiresAt: text('expires_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const requestLogs = sqliteTable(
  'request_logs',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id').notNull(),
    // @article topic:api-key-layer
    // 同樣 ON DELETE SET NULL：key 被停用/刪除都不影響歷史 log，只是外鍵
    // 清空。用來回答「這把 key 花了多少錢」（見 04-usage-cost.md 的彙總
    // 查詢，之後可以加 apiKeyId 篩選）。
    apiKeyId: text('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    // deployment 被刪除時只清外鍵（SET NULL），保留這筆 log；public_model_name／
    // provider_model_id 另外存快照，即使 deployment 之後被刪也不影響歷史顯示。
    deploymentId: text('deployment_id').references(() => modelDeployments.id, { onDelete: 'set null' }),
    publicModelName: text('public_model_name').notNull(),
    providerModelId: text('provider_model_id').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cost: real('cost').notNull().default(0),
    status: text('status', { enum: ['success', 'error'] }).notNull(),
    statusCode: integer('status_code'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    providerError: text('provider_error', { mode: 'json' }).$type<unknown>(),
    latencyMs: integer('latency_ms').notNull(),
    // @article topic:fallback-routing
    // fallbackUsed：只要最終服務這個請求的不是候選清單裡 priority 最小的
    // 那筆，就算 true（不論它自己成功、還是它失敗後換別筆成功）。
    // fallbackAttempts：這次請求總共嘗試了幾筆 deployment，1 代表沒有觸發
    // Fallback（第一筆就成功或失敗）。
    fallbackUsed: integer('fallback_used', { mode: 'boolean' }).notNull().default(false),
    fallbackAttempts: integer('fallback_attempts').notNull().default(1),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    // 04-usage-cost.md 已定案：至少在 created_at 上建索引（列表/彙總查詢的時間範圍篩選），
    // deployment_id 也建一個（依 model 分組查詢會用到）。
    index('request_logs_created_at_idx').on(table.createdAt),
    index('request_logs_deployment_id_idx').on(table.deploymentId),
  ],
);
