import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.SITE_SESSION_SECRET = randomBytes(32).toString('hex');

const { createApp } = await import('../app.js');
const { db, sqlite, schema } = await import('../db/index.js');
const { encrypt } = await import('../security/crypto.js');
const { TEST_SCHEMA_SQL } = await import('../db/test-helpers.js');
const { createSessionToken, SESSION_COOKIE_NAME } = await import('../auth/session.js');

sqlite.exec(TEST_SCHEMA_SQL);

// 見 credentials.routes.test.ts 的同一個修法（docs/auth-migration-plan.md
// Phase 1）：/admin/* 改用登入密碼的 session 驗證，測試直接 mint 一個合
// 法的 session token 當 Cookie。
const SESSION_TOKEN = await createSessionToken(process.env.SITE_SESSION_SECRET);

// @article topic:two-tier-health-check
// POST /admin/deployments 現在會在建立時觸發一次真的 runDeploymentModelCheck()
// （送一次 chat completion），fixture 的 baseUrl 不能再指向真實網域（原本
// 是 https://api.example.com/v1）——這裡改用真的本機假上游 server，跟
// chat.routes.test.ts 同一套手法，避免測試依賴外部網路、也讓結果是決定
// 性的（不會因為 example.com 回應內容跟預期不同而讓健康檢查結果飄動）。
let upstreamHandler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
};
const fakeUpstream = http.createServer((req, res) => upstreamHandler(req, res));
await new Promise<void>((resolve) => fakeUpstream.listen(0, resolve));
const upstreamBaseUrl = `http://localhost:${(fakeUpstream.address() as AddressInfo).port}/v1`;

after(() => {
  fakeUpstream.close();
});

const credentialId = 'cred-fixture-1';
db.insert(schema.credentials)
  .values({
    id: credentialId,
    name: 'fixture credential',
    adapterType: 'passthrough',
    baseUrl: upstreamBaseUrl,
    apiKeyEncrypted: encrypt('sk-fixture'),
    enabled: true,
    createdAt: new Date().toISOString(),
  })
  .run();

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

test('POST /admin/deployments priority 傳浮點數時回 400', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await authedFetch(baseUrl, '/admin/deployments', {
      method: 'POST',
      body: JSON.stringify({
        credentialId,
        publicModelName: 'test-model-float-priority',
        providerModelId: 'test-model-float-priority',
        priority: 1.5,
      }),
    });
    assert.equal(res.status, 400, 'priority 是排序用的整數，1.5 這種浮點值語意上不該通過');
    const body = (await res.json()) as any;
    assert.match(body.error.message, /priority must be an integer/);
  } finally {
    server.close();
  }
});

test('POST /admin/deployments enabled 傳數字 1 時回 400（不接受 truthy，只接受真正的 boolean）', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await authedFetch(baseUrl, '/admin/deployments', {
      method: 'POST',
      body: JSON.stringify({
        credentialId,
        publicModelName: 'test-model-numeric-enabled',
        providerModelId: 'test-model-numeric-enabled',
        enabled: 1,
      }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('POST /admin/deployments 正常請求成功建立，priority 預設 0，且建立時已經跑過一次真的健康檢查', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await authedFetch(baseUrl, '/admin/deployments', {
      method: 'POST',
      body: JSON.stringify({
        credentialId,
        publicModelName: 'test-model-ok',
        providerModelId: 'test-model-ok-provider',
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as any;
    assert.equal(body.priority, 0);
    assert.equal(body.enabled, true);
    assert.equal(body.autoHealthCheckEnabled, false);
    // @article topic:two-tier-health-check
    // 假上游預設回一個正常的 chat completion，建立當下就該是 healthy，
    // 不是 unknown——這是這次要修的行為本身：不用等使用者手動點或等真的
    // 請求失敗才知道這個 model 能不能用。
    assert.equal(body.healthStatus, 'healthy');
    assert.ok(body.lastCheckedAt);
  } finally {
    server.close();
  }
});

test('POST /admin/deployments 用不存在的 provider_model_id 建立時，回應已經標成 unhealthy（不用等手動檢查才發現）', async () => {
  upstreamHandler = (_req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'model not found' } }));
  };

  const { server, baseUrl } = await startServer();
  try {
    const res = await authedFetch(baseUrl, '/admin/deployments', {
      method: 'POST',
      body: JSON.stringify({
        credentialId,
        publicModelName: 'test-model-nonexistent',
        providerModelId: 'this-model-does-not-exist',
      }),
    });
    assert.equal(res.status, 201, '就算模型不存在，deployment 本身還是要建立成功，只是健康狀態標成 unhealthy');
    const body = (await res.json()) as any;
    assert.equal(body.healthStatus, 'unhealthy');
    assert.ok(body.lastError);
  } finally {
    server.close();
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    };
  }
});

test('POST /admin/deployments 建立時的自動檢查不算「手動」，lastManualCheckedAt 應該還是 null', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await authedFetch(baseUrl, '/admin/deployments', {
      method: 'POST',
      body: JSON.stringify({
        credentialId,
        publicModelName: 'test-model-auto-check-not-manual',
        providerModelId: 'test-model-auto-check-not-manual-provider',
      }),
    });
    const body = (await res.json()) as any;
    assert.ok(body.lastCheckedAt, '建立時應該已經跑過一次自動檢查');
    assert.equal(body.lastManualCheckedAt, null, '建立時的自動檢查不是使用者按按鈕，不該算進 lastManualCheckedAt');
  } finally {
    server.close();
  }
});

test('POST /admin/deployments/:id/health-check 手動觸發時會寫入 lastManualCheckedAt', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const createRes = await authedFetch(baseUrl, '/admin/deployments', {
      method: 'POST',
      body: JSON.stringify({
        credentialId,
        publicModelName: 'test-model-manual-check',
        providerModelId: 'test-model-manual-check-provider',
      }),
    });
    const created = (await createRes.json()) as any;
    assert.equal(created.lastManualCheckedAt, null, '建立當下的自動檢查不算手動');

    const checkRes = await authedFetch(baseUrl, `/admin/deployments/${created.id}/health-check`, { method: 'POST' });
    assert.equal(checkRes.status, 200);
    const body = (await checkRes.json()) as any;
    assert.ok(body.deployment.lastManualCheckedAt, '按下手動檢查按鈕之後，lastManualCheckedAt 應該被填上');
    assert.equal(body.deployment.lastManualCheckedAt, body.deployment.lastCheckedAt);
  } finally {
    server.close();
  }
});

test('PATCH /admin/deployments/:id priority 傳浮點數時回 400', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const createRes = await authedFetch(baseUrl, '/admin/deployments', {
      method: 'POST',
      body: JSON.stringify({
        credentialId,
        publicModelName: 'test-model-patch-target',
        providerModelId: 'test-model-patch-target-provider',
      }),
    });
    const created = (await createRes.json()) as any;

    const patchRes = await authedFetch(baseUrl, `/admin/deployments/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ priority: 2.1 }),
    });
    assert.equal(patchRes.status, 400);
  } finally {
    server.close();
  }
});

// @article topic:two-tier-health-check
// code review 2026-09-21 抓到的問題：改了 providerModelId/credentialId 卻
// 沒有讓舊的健康檢查結果失效，畫面會一直顯示編輯前那組設定的結果。

test('PATCH /admin/deployments/:id 改 providerModelId 時，健康狀態要被打回 unknown', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const createRes = await authedFetch(baseUrl, '/admin/deployments', {
      method: 'POST',
      body: JSON.stringify({
        credentialId,
        publicModelName: 'test-model-invalidate-on-model-change',
        providerModelId: 'test-model-invalidate-on-model-change-provider',
      }),
    });
    const created = (await createRes.json()) as any;
    assert.equal(created.healthStatus, 'healthy', '建立時的自動檢查應該先是 healthy，才看得出後面被打回 unknown');

    const patchRes = await authedFetch(baseUrl, `/admin/deployments/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ providerModelId: 'a-completely-different-model-id' }),
    });
    assert.equal(patchRes.status, 200);
    const updated = (await patchRes.json()) as any;
    assert.equal(updated.healthStatus, 'unknown', '換了要測試的 model，舊的健康結果不該繼續顯示');
    assert.equal(updated.lastCheckedAt, null);
    assert.equal(updated.lastError, null);
    assert.equal(updated.lastManualCheckedAt, null);
  } finally {
    server.close();
  }
});

test('PATCH /admin/deployments/:id 只改 priority（跟健康檢查無關的欄位）時，健康狀態維持不變', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const createRes = await authedFetch(baseUrl, '/admin/deployments', {
      method: 'POST',
      body: JSON.stringify({
        credentialId,
        publicModelName: 'test-model-no-invalidate-on-priority-change',
        providerModelId: 'test-model-no-invalidate-on-priority-change-provider',
      }),
    });
    const created = (await createRes.json()) as any;
    assert.equal(created.healthStatus, 'healthy');

    const patchRes = await authedFetch(baseUrl, `/admin/deployments/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ priority: 1 }),
    });
    const updated = (await patchRes.json()) as any;
    assert.equal(updated.healthStatus, 'healthy', '改 priority 不影響這個 model 能不能用，健康狀態不該被清掉');
    assert.equal(updated.lastCheckedAt, created.lastCheckedAt);
  } finally {
    server.close();
  }
});

test('PATCH /admin/deployments/:id 把 providerModelId 改成同一個值時，不算變更，健康狀態維持不變', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const createRes = await authedFetch(baseUrl, '/admin/deployments', {
      method: 'POST',
      body: JSON.stringify({
        credentialId,
        publicModelName: 'test-model-no-invalidate-on-same-value',
        providerModelId: 'unchanged-provider-model-id',
      }),
    });
    const created = (await createRes.json()) as any;
    assert.equal(created.healthStatus, 'healthy');

    const patchRes = await authedFetch(baseUrl, `/admin/deployments/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ providerModelId: 'unchanged-provider-model-id' }),
    });
    const updated = (await patchRes.json()) as any;
    assert.equal(updated.healthStatus, 'healthy', '值沒有真的改變，不該誤判成需要重新檢查');
  } finally {
    server.close();
  }
});

// @article topic:two-tier-health-check
// code review 2026-09-21 抓到的問題：建立時原本無條件 await 真的 chat()
// 檢查，上游慢的話「新增 Deployment」對話框最差要卡到 30 秒。改成只等一
// 個短暫上限，這裡用故意拖很久的假上游驗證：回應真的很慢也不會讓
// POST /admin/deployments 卡住太久。

test('POST /admin/deployments 上游健康檢查回應很慢時，不會讓建立請求卡到上游真正回應為止', async () => {
  // 故意設成「比建立時願意等的上限（8 秒）還久，但沒久到誇張」——只要
  // 大於 8 秒就能證明真的有短路，不用真的等到 REQUEST_TIMEOUT_MS（30 秒）
  // 那麼久，避免這筆背景還在跑的請求把整個測試檔案拖慢太多。
  upstreamHandler = (_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    }, 9_500);
  };

  const { server, baseUrl } = await startServer();
  try {
    const start = Date.now();
    const res = await authedFetch(baseUrl, '/admin/deployments', {
      method: 'POST',
      body: JSON.stringify({
        credentialId,
        publicModelName: 'test-model-slow-upstream',
        providerModelId: 'test-model-slow-upstream-provider',
      }),
    });
    const elapsedMs = Date.now() - start;
    assert.equal(res.status, 201, '就算健康檢查還沒有結果，deployment 本身還是要建立成功');
    assert.ok(elapsedMs < 15_000, `建立請求應該遠早於上游的 60 秒回應就先回來，實際花了 ${elapsedMs}ms`);
    const body = (await res.json()) as any;
    assert.equal(body.healthStatus, 'unknown', '沒等到上游回應，健康狀態應該維持 unknown，不能亂猜');
  } finally {
    server.close();
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    };
  }
});
