import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';

process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');

const { createTestDb, schema } = await import('../db/test-helpers.js');
const { encrypt } = await import('../security/crypto.js');
const { runScheduledHealthChecks } = await import('./scheduler.js');

// @article topic:two-tier-health-check
// 2026-09-21 起排程改用 runDeploymentModelCheck()（真的送一次 chat
// completion），不是原本的輕量 ping()——假上游要回 chat completion 的
// 形狀（choices[0].message.content + usage），不是 GET /models 的
// {data: []}，不然 PassthroughAdapter.chat() 會因為回應形狀不對拋錯，
// 被誤判成 unhealthy。
let checkCount = 0;
const fakeUpstream = http.createServer((_req: IncomingMessage, res: ServerResponse) => {
  checkCount++;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
});
await new Promise<void>((resolve) => fakeUpstream.listen(0, resolve));
const upstreamBaseUrl = `http://localhost:${(fakeUpstream.address() as AddressInfo).port}/v1`;

after(() => {
  fakeUpstream.close();
});

function seedCredentialAndDeployment(
  db: ReturnType<typeof createTestDb>['db'],
  id: string,
  opts: { credentialEnabled?: boolean; deploymentEnabled?: boolean; autoHealthCheckEnabled?: boolean },
) {
  const now = new Date().toISOString();
  db.insert(schema.credentials)
    .values({
      id: `cred-${id}`,
      name: `cred-${id}`,
      adapterType: 'passthrough',
      baseUrl: upstreamBaseUrl,
      apiKeyEncrypted: encrypt('sk-fake'),
      enabled: opts.credentialEnabled ?? true,
      createdAt: now,
    })
    .run();

  db.insert(schema.modelDeployments)
    .values({
      id: `dep-${id}`,
      credentialId: `cred-${id}`,
      publicModelName: `model-${id}`,
      providerModelId: 'provider-id',
      priority: 0,
      enabled: opts.deploymentEnabled ?? true,
      autoHealthCheckEnabled: opts.autoHealthCheckEnabled ?? false,
      healthStatus: 'unknown',
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

test('runScheduledHealthChecks() 只檢查 autoHealthCheckEnabled=true 且 deployment/credential 都 enabled 的候選', async () => {
  const { db } = createTestDb();
  seedCredentialAndDeployment(db, 'included', { autoHealthCheckEnabled: true });
  seedCredentialAndDeployment(db, 'not-opted-in', { autoHealthCheckEnabled: false });
  seedCredentialAndDeployment(db, 'deployment-disabled', { autoHealthCheckEnabled: true, deploymentEnabled: false });
  seedCredentialAndDeployment(db, 'credential-disabled', { autoHealthCheckEnabled: true, credentialEnabled: false });

  checkCount = 0;
  await runScheduledHealthChecks(db);

  assert.equal(checkCount, 1, '四筆裡只有一筆符合條件，應該只打一次檢查');

  const included = db.select().from(schema.modelDeployments).where(eq(schema.modelDeployments.id, 'dep-included')).get();
  assert.equal(included?.healthStatus, 'healthy');

  const notOptedIn = db.select().from(schema.modelDeployments).where(eq(schema.modelDeployments.id, 'dep-not-opted-in')).get();
  assert.equal(notOptedIn?.healthStatus, 'unknown', '沒開排程的維持原狀，不會被掃到');
});

test('runScheduledHealthChecks() 單筆檢查失敗不影響其他筆繼續執行', async () => {
  const { db } = createTestDb();
  seedCredentialAndDeployment(db, 'a', { autoHealthCheckEnabled: true });
  seedCredentialAndDeployment(db, 'b', { autoHealthCheckEnabled: true });

  // 把其中一筆的 credential 改用壞掉的 base_url，讓它的深層檢查連不上、
  // 失敗，驗證另一筆仍然正常執行完成。
  db.update(schema.credentials)
    .set({ baseUrl: 'http://127.0.0.1:1/v1' }) // 幾乎必定連線失敗的位址
    .where(eq(schema.credentials.id, 'cred-a'))
    .run();

  await assert.doesNotReject(runScheduledHealthChecks(db));

  const a = db.select().from(schema.modelDeployments).where(eq(schema.modelDeployments.id, 'dep-a')).get();
  const b = db.select().from(schema.modelDeployments).where(eq(schema.modelDeployments.id, 'dep-b')).get();
  assert.equal(a?.healthStatus, 'unhealthy');
  assert.equal(b?.healthStatus, 'healthy', '另一筆沒有被拖垮，正常檢查完成');
});
