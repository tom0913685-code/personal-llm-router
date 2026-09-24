import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

// 整合測試需要在 app.js（連帶 db/index.js 這個 singleton）第一次被 import
// 之前就設好環境變數，見 gateway/chat.routes.test.ts 的同一個 gotcha。
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

// db/index.ts 對 singleton sqlite 連線開了 foreign_keys=ON，request_logs.
// deployment_id 是外鍵，seedLog() 傳非 null 的 deploymentId 前要先有對應的
// model_deployments 列存在，否則寫入會被 FK constraint 擋下來。
db.insert(schema.credentials)
  .values({
    id: 'cred-fixture',
    name: 'fixture credential',
    adapterType: 'passthrough',
    baseUrl: 'https://api.example.com/v1',
    apiKeyEncrypted: encrypt('sk-fixture'),
    enabled: true,
    createdAt: new Date().toISOString(),
  })
  .run();
for (const id of ['dep-primary', 'dep-fallback', 'dep-a', 'dep-b', 'dep-rename-test']) {
  db.insert(schema.modelDeployments)
    .values({
      id,
      credentialId: 'cred-fixture',
      publicModelName: `fixture-${id}`,
      providerModelId: `fixture-${id}`,
      priority: 0,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      enabled: true,
      healthStatus: 'unknown',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

function seedLog(overrides: Partial<typeof schema.requestLogs.$inferInsert> = {}) {
  db.insert(schema.requestLogs)
    .values({
      id: randomUUID(),
      requestId: randomUUID(),
      publicModelName: 'gpt-4o-test',
      providerModelId: 'gpt-4o-provider',
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.001,
      status: 'success',
      statusCode: 200,
      latencyMs: 200,
      fallbackUsed: false,
      fallbackAttempts: 1,
      createdAt: new Date().toISOString(),
      ...overrides,
    })
    .run();
}

async function startServer() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://localhost:${port}` };
}

test('GET /admin/logs 沒有 session cookie 回 401', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/admin/logs`);
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('GET /admin/logs 依 status 篩選，並依 created_at 新到舊排序', async () => {
  seedLog({ status: 'success', publicModelName: 'model-a' });
  seedLog({ status: 'error', cost: 0, errorCode: 'upstream_error', publicModelName: 'model-b' });
  seedLog({ status: 'success', publicModelName: 'model-a' });

  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/admin/logs?status=error`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.ok(body.items.length >= 1);
    assert.ok(body.items.every((l: any) => l.status === 'error'));
  } finally {
    server.close();
  }
});

test('GET /admin/logs 依 publicModelName 篩選（模糊比對）與分頁', async () => {
  for (let i = 0; i < 3; i++) seedLog({ publicModelName: 'filter-target-model' });
  seedLog({ publicModelName: 'other-model' });

  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/admin/logs?publicModelName=filter-target&page=1&pageSize=2`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
    });
    const body = (await res.json()) as any;
    assert.equal(body.total, 3);
    assert.equal(body.items.length, 2);
    assert.ok(body.items.every((l: any) => l.publicModelName === 'filter-target-model'));
  } finally {
    server.close();
  }
});

test('GET /admin/logs rangeHours 篩選掉時間範圍外的紀錄', async () => {
  const oldTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  seedLog({ publicModelName: 'range-test-model', createdAt: oldTimestamp });
  seedLog({ publicModelName: 'range-test-model' });

  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/admin/logs?publicModelName=range-test-model&rangeHours=24`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
    });
    const body = (await res.json()) as any;
    assert.equal(body.total, 1);
  } finally {
    server.close();
  }
});

test('GET /admin/logs/daily 依 UTC 曆日分桶，範圍內沒有請求的日子補 0', async () => {
  // 同一個 in-memory db 被這個檔案裡其他測試共用，其他測試也可能 seed 過
  // 「今天」或「N 天前」同一個 bucket 的資料（例如上面 rangeHours 那個測試
  // 用的是 48 小時前）。所以全面採「前後差值」驗證每個 bucket 的變化量，
  // 而不是斷言絕對值，避免跟測試執行順序/其他測試的資料耦合（見
  // gateway/chat.routes.test.ts 的同一個模式）。
  const today = new Date().toISOString().slice(0, 10);
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const twoDaysAgoDate = twoDaysAgo.slice(0, 10);

  async function fetchDaily() {
    const res = await fetch(`${baseUrl}/admin/logs/daily?days=7`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
    });
    return (await res.json()) as { days: { date: string; cost: number; requests: number }[] };
  }

  const { server, baseUrl } = await startServer();
  try {
    const before = await fetchDaily();
    const todayBefore = before.days.find((d) => d.date === today)!;
    const twoDaysAgoBefore = before.days.find((d) => d.date === twoDaysAgoDate)!;
    // 找一個範圍內、before 這次就已經是 0 的日子，之後拿來驗證「沒補到的
    // 日子維持 0」——只要有一天沒被其他測試碰過就夠用。
    const untouchedDateBefore = before.days.find((d) => d.date !== today && d.date !== twoDaysAgoDate && d.requests === 0);

    seedLog({ cost: 0.01, createdAt: new Date().toISOString() });
    seedLog({ cost: 0.02, createdAt: new Date().toISOString() });
    seedLog({ cost: 0.05, createdAt: twoDaysAgo });

    const body = await fetchDaily();
    assert.equal(body.days.length, 7);

    const todayBucket = body.days.find((d) => d.date === today);
    assert.ok(todayBucket, '今天應該要有一個 bucket');
    assert.ok(Math.abs(todayBucket.cost - todayBefore.cost - 0.03) < 1e-9);
    assert.equal(todayBucket.requests, todayBefore.requests + 2);

    const twoDaysAgoBucket = body.days.find((d) => d.date === twoDaysAgoDate);
    assert.ok(twoDaysAgoBucket);
    assert.ok(Math.abs(twoDaysAgoBucket.cost - twoDaysAgoBefore.cost - 0.05) < 1e-9);
    assert.equal(twoDaysAgoBucket.requests, twoDaysAgoBefore.requests + 1);

    // 範圍內、完全沒被這次或其他測試碰過的日子應該維持 cost=0/requests=0，
    // 而不是被跳過。
    if (untouchedDateBefore) {
      const untouchedBucket = body.days.find((d) => d.date === untouchedDateBefore.date);
      assert.ok(untouchedBucket);
      assert.equal(untouchedBucket.cost, 0);
      assert.equal(untouchedBucket.requests, 0);
    }
  } finally {
    server.close();
  }
});

test('GET /admin/logs/daily days 參數決定回傳幾天', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/admin/logs/daily?days=3`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
    });
    const body = (await res.json()) as any;
    assert.equal(body.days.length, 3);
  } finally {
    server.close();
  }
});

test('GET /admin/logs/summary 回傳花費/請求數/錯誤率/fallback 觸發率彙總', async () => {
  const marker = `summary-test-${randomUUID()}`;
  seedLog({ publicModelName: marker, status: 'success', cost: 0.01, fallbackUsed: false });
  seedLog({ publicModelName: marker, status: 'success', cost: 0.02, fallbackUsed: true, fallbackAttempts: 2 });
  seedLog({ publicModelName: marker, status: 'error', cost: 0, fallbackUsed: false });

  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/admin/logs/summary?publicModelName=${marker}`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.totalRequests, 3);
    assert.ok(Math.abs(body.totalCost - 0.03) < 1e-9);
    assert.ok(Math.abs(body.errorRate - 1 / 3) < 1e-9);
    assert.ok(Math.abs(body.fallbackRate - 1 / 3) < 1e-9);
    assert.equal(body.byDeployment.length, 1);
    assert.equal(body.byDeployment[0].publicModelName, marker);
    assert.equal(body.byDeployment[0].requests, 3);
  } finally {
    server.close();
  }
});

test('GET /admin/logs/summary 的 byDeployment 顯示最新一筆快照的 publicModelName，不是隨機哪一筆舊快照', async () => {
  // 模擬「deployment 改過名字」：同一個 deploymentId 底下，較早的 log 存的
  // 是改名前的舊名字，較新的 log 才是現在的名字。彙總畫面該顯示現在叫
  // 什麼，不是撞上哪一筆就用哪一筆——這是使用者實際回報過的問題（Dashboard
  // 「模型使用分佈」顯示了已經改名前的舊名稱）。
  seedLog({
    deploymentId: 'dep-rename-test',
    publicModelName: 'old-name-before-rename',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  seedLog({
    deploymentId: 'dep-rename-test',
    publicModelName: 'new-name-after-rename',
    createdAt: '2026-06-01T00:00:00.000Z',
  });

  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/admin/logs/summary?deploymentId=dep-rename-test`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
    });
    const body = (await res.json()) as any;
    assert.equal(body.byDeployment.length, 1);
    assert.equal(body.byDeployment[0].requests, 2, '兩筆都要算進同一個 deployment 的加總');
    assert.equal(body.byDeployment[0].publicModelName, 'new-name-after-rename');
  } finally {
    server.close();
  }
});

test('GET /admin/logs/summary 的 byDeployment 依 deploymentId 分組，不會把同一個 public model 底下的 primary/fallback 合併成一列', async () => {
  const marker = `group-test-${randomUUID()}`;
  seedLog({ publicModelName: marker, deploymentId: 'dep-primary', cost: 0.01 });
  seedLog({ publicModelName: marker, deploymentId: 'dep-primary', cost: 0.02 });
  seedLog({ publicModelName: marker, deploymentId: 'dep-fallback', cost: 0.05 });

  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/admin/logs/summary?publicModelName=${marker}`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
    });
    const body = (await res.json()) as any;
    assert.equal(body.byDeployment.length, 2, '同一個 public model 名稱底下不同 deploymentId 應該分開列出');
    const primary = body.byDeployment.find((d: any) => d.deploymentId === 'dep-primary');
    const fallback = body.byDeployment.find((d: any) => d.deploymentId === 'dep-fallback');
    assert.ok(primary);
    assert.ok(fallback);
    assert.equal(primary.requests, 2);
    assert.ok(Math.abs(primary.cost - 0.03) < 1e-9);
    assert.equal(fallback.requests, 1);
    assert.ok(Math.abs(fallback.cost - 0.05) < 1e-9);
  } finally {
    server.close();
  }
});

test('GET /admin/logs 依 deploymentId 篩選', async () => {
  const marker = `deployment-filter-${randomUUID()}`;
  seedLog({ publicModelName: marker, deploymentId: 'dep-a' });
  seedLog({ publicModelName: marker, deploymentId: 'dep-b' });
  seedLog({ publicModelName: marker, deploymentId: 'dep-a' });

  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/admin/logs?publicModelName=${marker}&deploymentId=dep-a`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
    });
    const body = (await res.json()) as any;
    assert.equal(body.total, 2);
    assert.ok(body.items.every((l: any) => l.deploymentId === 'dep-a'));
  } finally {
    server.close();
  }
});
