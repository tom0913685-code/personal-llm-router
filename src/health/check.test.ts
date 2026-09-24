import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';

process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');

const { createTestDb, schema } = await import('../db/test-helpers.js');
const { encrypt } = await import('../security/crypto.js');
const { runDeploymentModelCheck, runCredentialConnectivityCheck } = await import('./check.js');

let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.writeHead(500).end();
const fakeUpstream = http.createServer((req, res) => handler(req, res));
await new Promise<void>((resolve) => fakeUpstream.listen(0, resolve));
const upstreamBaseUrl = `http://localhost:${(fakeUpstream.address() as AddressInfo).port}/v1`;

after(() => {
  fakeUpstream.close();
});

function seedDeployment(
  db: ReturnType<typeof createTestDb>['db'],
  credentialId: string,
  deploymentId: string,
  overrides: Partial<typeof schema.credentials.$inferInsert> = {},
) {
  const now = new Date().toISOString();
  db.insert(schema.credentials)
    .values({
      id: credentialId,
      name: `test credential ${credentialId}`,
      adapterType: 'passthrough',
      baseUrl: upstreamBaseUrl,
      apiKeyEncrypted: encrypt('sk-fake'),
      enabled: true,
      createdAt: now,
      ...overrides,
    })
    .run();

  db.insert(schema.modelDeployments)
    .values({
      id: deploymentId,
      credentialId,
      publicModelName: `model-${deploymentId}`,
      providerModelId: 'provider-id',
      priority: 0,
      enabled: true,
      autoHealthCheckEnabled: false,
      healthStatus: 'unknown',
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

// @article topic:two-tier-health-check
// runDeploymentModelCheck()：真的送一次最小化 chat 請求，用 deployment
// 設定的 provider_model_id——這是修「credential 連線正常，但 model 名稱
// 打錯/不存在時只驗連線的檢查測不出來」這個問題的核心。2026-09-21 起
// 排程也改用這個函式（不再有獨立的輕量 ping 版本），manual 參數決定要
// 不要額外寫 lastManualCheckedAt。

test('runDeploymentModelCheck() 上游成功回應 chat completion 時回傳 healthy', async () => {
  const { db } = createTestDb();
  seedDeployment(db, 'cred-model-ok', 'dep-model-ok');
  handler = (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  };

  const result = await runDeploymentModelCheck('dep-model-ok', db);
  assert.equal(result.healthStatus, 'healthy');

  const updated = db.select().from(schema.modelDeployments).where(eq(schema.modelDeployments.id, 'dep-model-ok')).get();
  assert.equal(updated?.healthStatus, 'healthy');
});

test('runDeploymentModelCheck() provider_model_id 不存在（上游回 404）時回傳 unhealthy——這是 runHealthCheck() 測不出來的情況', async () => {
  const { db } = createTestDb();
  seedDeployment(db, 'cred-model-missing', 'dep-model-missing');
  handler = (_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'model not found' } }));
  };

  const result = await runDeploymentModelCheck('dep-model-missing', db);
  assert.equal(result.healthStatus, 'unhealthy');
  assert.ok(result.error);

  const updated = db.select().from(schema.modelDeployments).where(eq(schema.modelDeployments.id, 'dep-model-missing')).get();
  assert.equal(updated?.healthStatus, 'unhealthy');
  assert.ok(updated?.lastError);
});

test('runDeploymentModelCheck() 對不存在的 deployment 拋出 NotFoundError', async () => {
  const { db } = createTestDb();
  await assert.rejects(runDeploymentModelCheck('does-not-exist', db), /not found/);
});

test('runDeploymentModelCheck() 預設（manual 沒傳）不會寫入 lastManualCheckedAt——給排程/建立時的自動檢查用', async () => {
  const { db } = createTestDb();
  seedDeployment(db, 'cred-auto', 'dep-auto');
  handler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  };

  await runDeploymentModelCheck('dep-auto', db);

  const updated = db.select().from(schema.modelDeployments).where(eq(schema.modelDeployments.id, 'dep-auto')).get();
  assert.ok(updated?.lastCheckedAt, 'lastCheckedAt 不分來源，這次檢查一定要更新');
  assert.equal(updated?.lastManualCheckedAt, null, '沒有明確傳 manual:true，不該動到 lastManualCheckedAt');
});

test('runDeploymentModelCheck() manual:true 時額外寫入 lastManualCheckedAt——給「手動檢查」按鈕用', async () => {
  const { db } = createTestDb();
  seedDeployment(db, 'cred-manual', 'dep-manual');
  handler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  };

  await runDeploymentModelCheck('dep-manual', db, { manual: true });

  const updated = db.select().from(schema.modelDeployments).where(eq(schema.modelDeployments.id, 'dep-manual')).get();
  assert.ok(updated?.lastManualCheckedAt);
  assert.equal(updated?.lastManualCheckedAt, updated?.lastCheckedAt, '同一次檢查，兩個時間戳應該一致');
});

// @article topic:two-tier-health-check
// runCredentialConnectivityCheck()：只驗連線/認證（跟 runHealthCheck()
// 邏輯一樣打 /models），差別是直接對 credential 操作、寫回 credentials
// 表自己的欄位，不透過任何 deployment。

test('runCredentialConnectivityCheck() 成功時回傳 healthy 並把結果寫回 credential', async () => {
  const { db } = createTestDb();
  const now = new Date().toISOString();
  db.insert(schema.credentials)
    .values({
      id: 'cred-conn-ok',
      name: 'conn-ok',
      adapterType: 'passthrough',
      baseUrl: upstreamBaseUrl,
      apiKeyEncrypted: encrypt('sk-fake'),
      enabled: true,
      createdAt: now,
    })
    .run();
  handler = (req, res) => {
    assert.equal(req.url, '/v1/models');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
  };

  const result = await runCredentialConnectivityCheck('cred-conn-ok', db);
  assert.equal(result.healthStatus, 'healthy');

  const updated = db.select().from(schema.credentials).where(eq(schema.credentials.id, 'cred-conn-ok')).get();
  assert.equal(updated?.connectivityStatus, 'healthy');
  assert.ok(updated?.lastCheckedAt);
});

test('runCredentialConnectivityCheck() 失敗時回傳 unhealthy 並記錄錯誤', async () => {
  const { db } = createTestDb();
  const now = new Date().toISOString();
  db.insert(schema.credentials)
    .values({
      id: 'cred-conn-fail',
      name: 'conn-fail',
      adapterType: 'passthrough',
      baseUrl: upstreamBaseUrl,
      apiKeyEncrypted: encrypt('sk-fake'),
      enabled: true,
      createdAt: now,
    })
    .run();
  handler = (_req, res) => {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('invalid api key');
  };

  const result = await runCredentialConnectivityCheck('cred-conn-fail', db);
  assert.equal(result.healthStatus, 'unhealthy');

  const updated = db.select().from(schema.credentials).where(eq(schema.credentials.id, 'cred-conn-fail')).get();
  assert.equal(updated?.connectivityStatus, 'unhealthy');
  assert.ok(updated?.lastError);
});

test('runCredentialConnectivityCheck() 對不存在的 credential 拋出 NotFoundError', async () => {
  const { db } = createTestDb();
  await assert.rejects(runCredentialConnectivityCheck('does-not-exist', db), /not found/);
});
