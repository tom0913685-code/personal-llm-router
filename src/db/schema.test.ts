import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from './test-helpers.js';

test('credentials -> model_deployments -> request_logs 三層可以正確寫入與查詢', () => {
  const { db } = createTestDb();
  const now = new Date().toISOString();

  db.insert(schema.credentials)
    .values({
      id: 'cred-1',
      name: 'OpenAI 個人 key',
      adapterType: 'passthrough',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEncrypted: 'encrypted-blob',
      enabled: true,
      createdAt: now,
    })
    .run();

  db.insert(schema.modelDeployments)
    .values({
      id: 'dep-1',
      credentialId: 'cred-1',
      publicModelName: 'gpt-4o',
      providerModelId: 'gpt-4o',
      inputCostPerMillion: 2.5,
      outputCostPerMillion: 10,
      enabled: true,
      healthStatus: 'unknown',
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(schema.requestLogs)
    .values({
      id: 'log-1',
      requestId: 'req-1',
      deploymentId: 'dep-1',
      publicModelName: 'gpt-4o',
      providerModelId: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.001,
      status: 'success',
      statusCode: 200,
      latencyMs: 400,
      createdAt: now,
    })
    .run();

  const cred = db.select().from(schema.credentials).where(eq(schema.credentials.id, 'cred-1')).get();
  assert.equal(cred?.name, 'OpenAI 個人 key');
  assert.equal(cred?.enabled, true);

  const deployment = db
    .select()
    .from(schema.modelDeployments)
    .where(eq(schema.modelDeployments.publicModelName, 'gpt-4o'))
    .get();
  assert.equal(deployment?.credentialId, 'cred-1');
  assert.equal(deployment?.healthStatus, 'unknown');

  const log = db.select().from(schema.requestLogs).where(eq(schema.requestLogs.id, 'log-1')).get();
  assert.equal(log?.status, 'success');
  assert.equal(log?.inputTokens, 100);
});

test('deployment 被刪除時，request_logs.deployment_id 會被 SET NULL 而非整筆刪除', () => {
  const { db } = createTestDb();
  const now = new Date().toISOString();

  db.insert(schema.credentials)
    .values({
      id: 'cred-1',
      name: 'Anthropic 個人 key',
      adapterType: 'anthropic_native',
      apiKeyEncrypted: 'encrypted-blob',
      enabled: true,
      createdAt: now,
    })
    .run();

  db.insert(schema.modelDeployments)
    .values({
      id: 'dep-1',
      credentialId: 'cred-1',
      publicModelName: 'claude-sonnet',
      providerModelId: 'claude-sonnet-5',
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(schema.requestLogs)
    .values({
      id: 'log-1',
      requestId: 'req-1',
      deploymentId: 'dep-1',
      publicModelName: 'claude-sonnet',
      providerModelId: 'claude-sonnet-5',
      status: 'success',
      latencyMs: 400,
      createdAt: now,
    })
    .run();

  db.delete(schema.modelDeployments).where(eq(schema.modelDeployments.id, 'dep-1')).run();

  const log = db.select().from(schema.requestLogs).where(eq(schema.requestLogs.id, 'log-1')).get();
  assert.ok(log, 'log 應該還存在，不會因為 deployment 被刪除而跟著消失');
  assert.equal(log?.deploymentId, null);
  assert.equal(log?.publicModelName, 'claude-sonnet', 'public_model_name 快照不受影響');
});
