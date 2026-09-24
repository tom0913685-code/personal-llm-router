import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, schema } from '../db/test-helpers.js';
import { resolveDeploymentCandidates } from './resolve.js';

function seedCredential(db: ReturnType<typeof createTestDb>['db'], overrides: Partial<typeof schema.credentials.$inferInsert> = {}) {
  const now = new Date().toISOString();
  const row = {
    id: 'cred-1',
    name: 'OpenAI 個人 key',
    adapterType: 'passthrough' as const,
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEncrypted: 'encrypted-blob',
    enabled: true,
    createdAt: now,
    ...overrides,
  };
  db.insert(schema.credentials).values(row).run();
  return row;
}

function seedDeployment(db: ReturnType<typeof createTestDb>['db'], overrides: Partial<typeof schema.modelDeployments.$inferInsert> = {}) {
  const now = new Date().toISOString();
  const row = {
    id: 'dep-1',
    credentialId: 'cred-1',
    publicModelName: 'gpt-4o',
    providerModelId: 'gpt-4o-provider',
    priority: 0,
    inputCostPerMillion: 2.5,
    outputCostPerMillion: 10,
    enabled: true,
    autoHealthCheckEnabled: false,
    healthStatus: 'unknown' as const,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  db.insert(schema.modelDeployments).values(row).run();
  return row;
}

test('resolveDeploymentCandidates() 找到單一 enabled 的 deployment 與其 credential', () => {
  const { db } = createTestDb();
  seedCredential(db);
  seedDeployment(db);

  const candidates = resolveDeploymentCandidates('gpt-4o', db);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].deployment.providerModelId, 'gpt-4o-provider');
  assert.equal(candidates[0].credential.id, 'cred-1');
});

test('resolveDeploymentCandidates() 找不到對應 model 時拋出 NotFoundError', () => {
  const { db } = createTestDb();
  assert.throws(() => resolveDeploymentCandidates('does-not-exist', db), /not configured or disabled/);
});

test('resolveDeploymentCandidates() deployment 被停用時視同找不到', () => {
  const { db } = createTestDb();
  seedCredential(db);
  seedDeployment(db, { enabled: false });

  assert.throws(() => resolveDeploymentCandidates('gpt-4o', db), /not configured or disabled/);
});

test('resolveDeploymentCandidates() deployment 啟用但所屬 credential 被停用時也視同找不到', () => {
  const { db } = createTestDb();
  seedCredential(db, { enabled: false });
  seedDeployment(db);

  assert.throws(() => resolveDeploymentCandidates('gpt-4o', db), /not configured or disabled/);
});

test('resolveDeploymentCandidates() 多筆候選依 priority 升冪排序', () => {
  const { db } = createTestDb();
  seedCredential(db, { id: 'cred-1', name: 'cred-a' });
  seedCredential(db, { id: 'cred-2', name: 'cred-b' });
  // 刻意用亂序 insert，驗證回傳順序是照 priority 排的，不是照 insert 順序
  seedDeployment(db, { id: 'dep-backup', credentialId: 'cred-2', priority: 2, providerModelId: 'backup' });
  seedDeployment(db, { id: 'dep-primary', credentialId: 'cred-1', priority: 0, providerModelId: 'primary' });
  seedDeployment(db, { id: 'dep-secondary', credentialId: 'cred-2', priority: 1, providerModelId: 'secondary' });

  const candidates = resolveDeploymentCandidates('gpt-4o', db);
  assert.deepEqual(
    candidates.map((c) => c.deployment.providerModelId),
    ['primary', 'secondary', 'backup'],
  );
});

test('resolveDeploymentCandidates() 停用的候選不會出現在清單裡，但其他候選仍照常回傳', () => {
  const { db } = createTestDb();
  seedCredential(db, { id: 'cred-1', name: 'cred-a' });
  seedDeployment(db, { id: 'dep-primary', priority: 0, providerModelId: 'primary', enabled: false });
  seedDeployment(db, { id: 'dep-secondary', priority: 1, providerModelId: 'secondary' });

  const candidates = resolveDeploymentCandidates('gpt-4o', db);
  assert.deepEqual(
    candidates.map((c) => c.deployment.providerModelId),
    ['secondary'],
  );
});
