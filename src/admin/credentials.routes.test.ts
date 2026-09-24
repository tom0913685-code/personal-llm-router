import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// 見 gateway/chat.routes.test.ts 的同一個 gotcha：環境變數要在 app.js（連帶
// db/index.js 這個 singleton）第一次被 import 之前設好。
process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.SITE_SESSION_SECRET = randomBytes(32).toString('hex');

const { createApp } = await import('../app.js');
const { sqlite } = await import('../db/index.js');
const { TEST_SCHEMA_SQL } = await import('../db/test-helpers.js');
const { createSessionToken, SESSION_COOKIE_NAME } = await import('../auth/session.js');

sqlite.exec(TEST_SCHEMA_SQL);

// 2026-09-19：/admin/* 從 ROUTER_API_KEY 換成登入密碼的 session 驗證
// （見 docs/auth-migration-plan.md Phase 1），測試改成直接 mint 一個合法
// 的 session token 當 Cookie 帶，不用再走真正的登入表單。
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

// @article topic:two-tier-health-check
// 給「測試連線」端點用的假上游——跟 chat.routes.test.ts/deployments.routes.test.ts
// 同一套手法，避免測試依賴外部網路。
let upstreamHandler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [] }));
};
const fakeUpstream = http.createServer((req, res) => upstreamHandler(req, res));
await new Promise<void>((resolve) => fakeUpstream.listen(0, resolve));
const upstreamBaseUrl = `http://localhost:${(fakeUpstream.address() as AddressInfo).port}/v1`;

after(() => {
  fakeUpstream.close();
});

test('GET /admin/credentials 沒有 session cookie 時回 401', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/admin/credentials`);
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('GET /admin/credentials session cookie 是亂猜的字串時回 401', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/admin/credentials`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=not-a-real-session-token` },
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('POST /admin/credentials enabled 傳字串 "false" 會被拒絕，不會被 Boolean() 誤判成 true', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await authedFetch(baseUrl, '/admin/credentials', {
      method: 'POST',
      body: JSON.stringify({
        name: 'test-cred-string-false',
        adapterType: 'passthrough',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        enabled: 'false',
      }),
    });
    assert.equal(res.status, 400, 'enabled 是字串而非 boolean 時應該回 400，而不是被 Boolean("false")===true 誤判成功');
    const body = (await res.json()) as any;
    assert.match(body.error.message, /enabled must be a boolean/);
  } finally {
    server.close();
  }
});

test('POST /admin/credentials adapterType=passthrough 但沒給 baseUrl 時回 400', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await authedFetch(baseUrl, '/admin/credentials', {
      method: 'POST',
      body: JSON.stringify({ name: 'test-cred-no-baseurl', adapterType: 'passthrough', apiKey: 'sk-test' }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('PATCH /admin/credentials/:id baseUrl 傳空字串時回 400（POST 原本就會擋，PATCH 之前沒擋）', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const createRes = await authedFetch(baseUrl, '/admin/credentials', {
      method: 'POST',
      body: JSON.stringify({
        name: 'test-cred-patch-empty-baseurl',
        adapterType: 'passthrough',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
      }),
    });
    const created = (await createRes.json()) as any;

    const patchRes = await authedFetch(baseUrl, `/admin/credentials/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ baseUrl: '' }),
    });
    assert.equal(patchRes.status, 400, 'PATCH 應該跟 POST 一致擋掉 passthrough + 空 baseUrl 的組合');
  } finally {
    server.close();
  }
});

test('PATCH /admin/credentials/:id 把 adapterType 從 anthropic_native 改成 passthrough、卻沒同時給 baseUrl 時回 400', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const createRes = await authedFetch(baseUrl, '/admin/credentials', {
      method: 'POST',
      body: JSON.stringify({ name: 'test-cred-switch-type', adapterType: 'anthropic_native', apiKey: 'sk-ant-test' }),
    });
    const created = (await createRes.json()) as any;
    assert.equal(created.baseUrl, undefined, 'anthropic_native 建立時不會有 baseUrl');

    const patchRes = await authedFetch(baseUrl, `/admin/credentials/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ adapterType: 'passthrough' }),
    });
    assert.equal(
      patchRes.status,
      400,
      '改成 passthrough 卻沿用舊的 null baseUrl，應該在 PATCH 當下就被擋掉，不能留到之後真正呼叫 adapter 才爆炸',
    );
  } finally {
    server.close();
  }
});

test('PATCH /admin/credentials/:id 同時給 adapterType=passthrough 跟 baseUrl 時允許通過', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const createRes = await authedFetch(baseUrl, '/admin/credentials', {
      method: 'POST',
      body: JSON.stringify({ name: 'test-cred-switch-type-ok', adapterType: 'anthropic_native', apiKey: 'sk-ant-test' }),
    });
    const created = (await createRes.json()) as any;

    const patchRes = await authedFetch(baseUrl, `/admin/credentials/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ adapterType: 'passthrough', baseUrl: 'https://api.example.com/v1' }),
    });
    assert.equal(patchRes.status, 200);
    const updated = (await patchRes.json()) as any;
    assert.equal(updated.baseUrl, 'https://api.example.com/v1');
  } finally {
    server.close();
  }
});

// @article topic:two-tier-health-check
// 「測試連線」只驗證這組 base URL + api_key 能不能連上、認證過不過，
// 跟 deployments 的「手動檢查」（真的打 model）是分開的兩層。

test('POST /admin/credentials/:id/health-check 連線成功時回 healthy，且寫回 credential 的 connectivityStatus', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const createRes = await authedFetch(baseUrl, '/admin/credentials', {
      method: 'POST',
      body: JSON.stringify({ name: 'test-cred-conn-ok', adapterType: 'passthrough', baseUrl: upstreamBaseUrl, apiKey: 'sk-test' }),
    });
    const created = (await createRes.json()) as any;
    assert.equal(created.connectivityStatus, 'unknown', '新建立時還沒檢查過，應該是 unknown，不是自動假設 healthy');

    const checkRes = await authedFetch(baseUrl, `/admin/credentials/${created.id}/health-check`, { method: 'POST' });
    assert.equal(checkRes.status, 200);
    const body = (await checkRes.json()) as any;
    assert.equal(body.healthStatus, 'healthy');
    assert.equal(body.credential.connectivityStatus, 'healthy');
    assert.equal(body.credential.apiKeyEncrypted, undefined, '測試連線的回應也不該外流 apiKeyEncrypted');
  } finally {
    server.close();
  }
});

test('POST /admin/credentials/:id/health-check 連線失敗時回 unhealthy', async () => {
  upstreamHandler = (_req, res) => {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('invalid api key');
  };

  const { server, baseUrl } = await startServer();
  try {
    const createRes = await authedFetch(baseUrl, '/admin/credentials', {
      method: 'POST',
      body: JSON.stringify({ name: 'test-cred-conn-fail', adapterType: 'passthrough', baseUrl: upstreamBaseUrl, apiKey: 'sk-test' }),
    });
    const created = (await createRes.json()) as any;

    const checkRes = await authedFetch(baseUrl, `/admin/credentials/${created.id}/health-check`, { method: 'POST' });
    assert.equal(checkRes.status, 200, '連線檢查本身沒有拋錯，用 200 + healthStatus:unhealthy 表達檢查結果');
    const body = (await checkRes.json()) as any;
    assert.equal(body.healthStatus, 'unhealthy');
    assert.equal(body.credential.connectivityStatus, 'unhealthy');
  } finally {
    server.close();
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    };
  }
});

test('POST /admin/credentials/:id/health-check 對不存在的 credential 回 404', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await authedFetch(baseUrl, '/admin/credentials/does-not-exist/health-check', { method: 'POST' });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

// @article topic:two-tier-health-check
// code review 2026-09-21 抓到的問題：改了 apiKey/baseUrl/adapterType 卻沒
// 有讓舊的 connectivityStatus 失效——金鑰輪替後，舊金鑰「連線正常」的結
// 果會一直留著，直到有人想到要手動再測一次。

test('PATCH /admin/credentials/:id 換了 apiKey 之後，connectivityStatus 要被打回 unknown', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const createRes = await authedFetch(baseUrl, '/admin/credentials', {
      method: 'POST',
      body: JSON.stringify({ name: 'test-cred-rotate-key', adapterType: 'passthrough', baseUrl: upstreamBaseUrl, apiKey: 'sk-old' }),
    });
    const created = (await createRes.json()) as any;
    await authedFetch(baseUrl, `/admin/credentials/${created.id}/health-check`, { method: 'POST' });

    const patchRes = await authedFetch(baseUrl, `/admin/credentials/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ apiKey: 'sk-new-rotated-key' }),
    });
    assert.equal(patchRes.status, 200);
    const updated = (await patchRes.json()) as any;
    assert.equal(updated.connectivityStatus, 'unknown', '換了金鑰，舊金鑰的連線結果不該繼續顯示成「健康」');
    // toSafeCredential() 把 null 轉成 undefined 才回給前端（跟 deployment
    // 的原始 row 回應不同，那邊是直接回 null）。
    assert.equal(updated.lastCheckedAt, undefined);
  } finally {
    server.close();
  }
});

test('PATCH /admin/credentials/:id 換了 baseUrl 之後，connectivityStatus 要被打回 unknown', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const createRes = await authedFetch(baseUrl, '/admin/credentials', {
      method: 'POST',
      body: JSON.stringify({ name: 'test-cred-change-url', adapterType: 'passthrough', baseUrl: upstreamBaseUrl, apiKey: 'sk-test' }),
    });
    const created = (await createRes.json()) as any;
    await authedFetch(baseUrl, `/admin/credentials/${created.id}/health-check`, { method: 'POST' });

    const patchRes = await authedFetch(baseUrl, `/admin/credentials/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ baseUrl: 'https://a-completely-different-endpoint.example.com/v1' }),
    });
    const updated = (await patchRes.json()) as any;
    assert.equal(updated.connectivityStatus, 'unknown', '換了要連的位址，舊位址的連線結果不該繼續顯示');
  } finally {
    server.close();
  }
});

test('PATCH /admin/credentials/:id 只改 name（跟連線無關的欄位）時，connectivityStatus 維持不變', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const createRes = await authedFetch(baseUrl, '/admin/credentials', {
      method: 'POST',
      body: JSON.stringify({ name: 'test-cred-rename', adapterType: 'passthrough', baseUrl: upstreamBaseUrl, apiKey: 'sk-test' }),
    });
    const created = (await createRes.json()) as any;
    await authedFetch(baseUrl, `/admin/credentials/${created.id}/health-check`, { method: 'POST' });

    const patchRes = await authedFetch(baseUrl, `/admin/credentials/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'renamed-credential' }),
    });
    const updated = (await patchRes.json()) as any;
    assert.equal(updated.connectivityStatus, 'healthy', '改名字不影響連線本身，不該把已經測過的結果清掉');
  } finally {
    server.close();
  }
});
