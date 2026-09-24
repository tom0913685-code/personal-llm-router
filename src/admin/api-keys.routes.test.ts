import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.SITE_SESSION_SECRET = randomBytes(32).toString('hex');

const { createApp } = await import('../app.js');
const { sqlite } = await import('../db/index.js');
const { TEST_SCHEMA_SQL } = await import('../db/test-helpers.js');
const { createSessionToken, SESSION_COOKIE_NAME } = await import('../auth/session.js');

sqlite.exec(TEST_SCHEMA_SQL);

// 見 credentials.routes.test.ts / deployments.routes.test.ts 同一套修法
// （docs/auth-migration-plan.md Phase 1）：/admin/* 用登入密碼的 session
// 驗證，測試直接 mint 一個合法的 session token 當 Cookie。
const SESSION_TOKEN = await createSessionToken(process.env.SITE_SESSION_SECRET);

async function startServer() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://localhost:${port}` };
}

function authedFetch(baseUrl: string, path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}`, 'Content-Type': 'application/json', ...init?.headers },
  });
}

test('GET /admin/api-keys 沒有 session cookie 時回 401', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/admin/api-keys`);
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('POST /admin/api-keys 建立成功時回 201，plaintextKey 只在這次回應出現，且回應不含 keyHash', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await authedFetch(baseUrl, '/admin/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'my key' }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as any;
    assert.equal(body.name, 'my key');
    assert.equal(body.enabled, true);
    assert.equal(body.budgetLimit, null);
    assert.equal(body.currentSpend, 0);
    assert.equal(body.keyHash, undefined, 'keyHash 絕對不能吐給前端');
    assert.match(body.plaintextKey, /^sk-[0-9a-f]{64}$/);
    assert.equal(body.keyPrefix, `sk-${body.plaintextKey.slice(3, 10)}`);
  } finally {
    server.close();
  }
});

test('POST /admin/api-keys name 是空字串時回 400', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await authedFetch(baseUrl, '/admin/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name: '' }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /admin/api-keys budgetResetDay 傳 32 時回 400（超出 1-31 範圍）', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await authedFetch(baseUrl, '/admin/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'bad reset day', budgetResetDay: 32 }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.match(body.error.message, /budgetResetDay/);
  } finally {
    server.close();
  }
});

test('POST /admin/api-keys expiresAt 傳不是合法日期的字串時回 400', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await authedFetch(baseUrl, '/admin/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'bad expires at', expiresAt: 'not-a-real-date' }),
    });
    assert.equal(res.status, 400, 'expiresAt 格式錯誤不該被靜默存進 DB 變成「永不過期」');
    const body = (await res.json()) as any;
    assert.match(body.error.message, /expiresAt/);
  } finally {
    server.close();
  }
});

test('POST /admin/api-keys allowedModels 傳非字串陣列時回 400', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await authedFetch(baseUrl, '/admin/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'bad allowed models', allowedModels: [1, 2] }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('GET /admin/api-keys 列出的每一筆都不含 keyHash', async () => {
  const { server, baseUrl } = await startServer();
  try {
    await authedFetch(baseUrl, '/admin/api-keys', { method: 'POST', body: JSON.stringify({ name: 'listed key' }) });
    const res = await authedFetch(baseUrl, '/admin/api-keys');
    assert.equal(res.status, 200);
    const body = (await res.json()) as any[];
    assert.ok(body.length >= 1);
    for (const row of body) {
      assert.equal(row.keyHash, undefined);
    }
  } finally {
    server.close();
  }
});

test('PATCH /admin/api-keys/:id 可以更新 name/enabled/budgetLimit，但不會動到 key 本身', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const created = await authedFetch(baseUrl, '/admin/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'to be patched' }),
    });
    const { id, keyPrefix } = (await created.json()) as any;

    const res = await authedFetch(baseUrl, `/admin/api-keys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'patched name', enabled: false, budgetLimit: 10 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.name, 'patched name');
    assert.equal(body.enabled, false);
    assert.equal(body.budgetLimit, 10);
    assert.equal(body.keyPrefix, keyPrefix, 'PATCH 不該換掉 key 本身');
  } finally {
    server.close();
  }
});

test('PATCH /admin/api-keys/:id 對不存在的 id 回 404', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await authedFetch(baseUrl, '/admin/api-keys/does-not-exist', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('POST /admin/api-keys/:id/regenerate 換發新明文與新 prefix，其餘欄位（如 name）不變', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const created = await authedFetch(baseUrl, '/admin/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'to be regenerated' }),
    });
    const original = (await created.json()) as any;

    const res = await authedFetch(baseUrl, `/admin/api-keys/${original.id}/regenerate`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.name, 'to be regenerated');
    assert.notEqual(body.plaintextKey, original.plaintextKey, '重新產生後明文應該換成新的');
    assert.notEqual(body.keyPrefix, original.keyPrefix, '重新產生後 prefix 應該換成新的');
    assert.match(body.plaintextKey, /^sk-[0-9a-f]{64}$/);
  } finally {
    server.close();
  }
});

test('POST /admin/api-keys/:id/reset-budget 無條件把 current_spend 歸零並更新 last_reset_at', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const created = await authedFetch(baseUrl, '/admin/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'to be reset', budgetLimit: 5 }),
    });
    const { id } = (await created.json()) as any;

    await authedFetch(baseUrl, `/admin/api-keys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ budgetLimit: 5 }),
    });

    const res = await authedFetch(baseUrl, `/admin/api-keys/${id}/reset-budget`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.currentSpend, 0);
    assert.ok(body.lastResetAt, 'reset-budget 之後 lastResetAt 應該被填上');
  } finally {
    server.close();
  }
});
