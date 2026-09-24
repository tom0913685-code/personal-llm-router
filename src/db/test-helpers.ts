import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

// 共用的測試用建表 SQL（等同套用 drizzle/0000_*.sql 的內容），不依賴
// migration 檔案路徑。給 schema.test.ts、routing/resolve.test.ts 的獨立
// in-memory DB 用，也給 gateway 整合測試套在 singleton db（src/db/index.ts）
// 指向的 :memory: 連線上用，避免各自重複貼一份建表 SQL。
export const TEST_SCHEMA_SQL = `
  CREATE TABLE credentials (
    id text PRIMARY KEY NOT NULL,
    name text NOT NULL UNIQUE,
    adapter_type text NOT NULL,
    base_url text,
    api_key_encrypted text NOT NULL,
    enabled integer DEFAULT true NOT NULL,
    connectivity_status text DEFAULT 'unknown' NOT NULL,
    last_checked_at text,
    last_latency_ms integer,
    last_error text,
    created_at text NOT NULL
  );
  CREATE TABLE model_deployments (
    id text PRIMARY KEY NOT NULL,
    credential_id text NOT NULL REFERENCES credentials(id),
    public_model_name text NOT NULL,
    provider_model_id text NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    input_cost_per_million real DEFAULT 0 NOT NULL,
    output_cost_per_million real DEFAULT 0 NOT NULL,
    enabled integer DEFAULT true NOT NULL,
    auto_health_check_enabled integer DEFAULT false NOT NULL,
    health_status text DEFAULT 'unknown' NOT NULL,
    last_checked_at text,
    last_latency_ms integer,
    last_error text,
    last_manual_checked_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  );
  CREATE UNIQUE INDEX model_deployments_public_model_name_priority_idx ON model_deployments (public_model_name, priority);
  CREATE INDEX model_deployments_public_model_name_idx ON model_deployments (public_model_name);
  CREATE TABLE api_keys (
    id text PRIMARY KEY NOT NULL,
    name text NOT NULL,
    key_hash text NOT NULL UNIQUE,
    key_prefix text NOT NULL,
    enabled integer DEFAULT true NOT NULL,
    allowed_models text,
    budget_limit real,
    current_spend real DEFAULT 0 NOT NULL,
    budget_reset_day integer,
    last_reset_at text,
    expires_at text,
    created_at text NOT NULL,
    updated_at text NOT NULL
  );
  CREATE TABLE request_logs (
    id text PRIMARY KEY NOT NULL,
    request_id text NOT NULL,
    deployment_id text REFERENCES model_deployments(id) ON DELETE SET NULL,
    api_key_id text REFERENCES api_keys(id) ON DELETE SET NULL,
    public_model_name text NOT NULL,
    provider_model_id text NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    cost real DEFAULT 0 NOT NULL,
    status text NOT NULL,
    status_code integer,
    error_code text,
    error_message text,
    provider_error text,
    latency_ms integer NOT NULL,
    fallback_used integer DEFAULT false NOT NULL,
    fallback_attempts integer DEFAULT 1 NOT NULL,
    created_at text NOT NULL
  );
  CREATE INDEX request_logs_created_at_idx ON request_logs (created_at);
  CREATE INDEX request_logs_deployment_id_idx ON request_logs (deployment_id);
`;

// 記憶體 SQLite + 建表，不動到 data/router.db。給 schema.test.ts、
// routing/resolve.test.ts 這類不需要走 singleton／HTTP 層的單元測試用。
export function createTestDb(): { db: ReturnType<typeof drizzle<typeof schema>>; sqlite: InstanceType<typeof Database> } {
  const sqlite = new Database(':memory:');
  // SQLite 預設不強制外鍵約束，ON DELETE SET NULL 這類行為要開這個 pragma 才會生效。
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  sqlite.exec(TEST_SCHEMA_SQL);
  return { db, sqlite };
}

export { schema };
