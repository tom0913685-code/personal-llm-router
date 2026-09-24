import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';

// 整合測試需要在 app.js（連帶 db/index.js 這個 singleton）第一次被 import
// 之前就設好環境變數，ESM 的靜態 import 會在檔案最頂端就先跑完，所以這裡
// 用 dynamic import，確保 process.env 先設定好才觸發 db/index.ts 的
// `new Database(DB_PATH)`。
process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');

const { createApp } = await import('../app.js');
const { db, sqlite, schema } = await import('../db/index.js');
const { encrypt } = await import('../security/crypto.js');
const { TEST_SCHEMA_SQL } = await import('../db/test-helpers.js');
const { generateApiKey } = await import('../security/api-key.js');

sqlite.exec(TEST_SCHEMA_SQL);

// 2026-09-19：/v1/* 從固定 ROUTER_API_KEY 換成 Gateway API Key 層（見
// docs/auth-migration-plan.md Phase 2）。這把測試用 key 不設額度上限/模
// 型白名單/到期時間，行為等同「無限制」，跟原本 ROUTER_API_KEY 的權限範
// 圍一致，給不特別測試 API Key 層本身的既有測試案例沿用。
const defaultTestKey = generateApiKey();
const API_KEY = defaultTestKey.plaintext;

// 不 mock globalThis.fetch——測試用的外層 client fetch 跟
// PassthroughAdapter 內部打上游的 fetch 是同一個 global，mock 掉會連自己
// 呼叫本地測試 server 的請求都攔截掉。改成真的起一個假上游 HTTP server，
// 用可替換的 handler 讓各測試案例控制回應內容，更貼近真實整合測試。
let upstreamHandler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
  res.writeHead(500).end('no handler set for this test');
};
const fakeUpstream = http.createServer((req, res) => upstreamHandler(req, res));
await new Promise<void>((resolve) => fakeUpstream.listen(0, resolve));
const upstreamBaseUrl = `http://localhost:${(fakeUpstream.address() as AddressInfo).port}/v1`;

// 第二個假上游，專門給 Fallback 測試用——primary/secondary 兩筆候選要能
// 各自獨立控制成功/失敗，才測得出「primary 失敗、換 secondary」的行為。
let secondaryUpstreamHandler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
  res.writeHead(500).end('no handler set for this test');
};
const secondaryUpstream = http.createServer((req, res) => secondaryUpstreamHandler(req, res));
await new Promise<void>((resolve) => secondaryUpstream.listen(0, resolve));
const secondaryUpstreamBaseUrl = `http://localhost:${(secondaryUpstream.address() as AddressInfo).port}/v1`;

after(() => {
  fakeUpstream.close();
  secondaryUpstream.close();
});

function seed() {
  const now = new Date().toISOString();
  db.insert(schema.credentials)
    .values({
      id: 'cred-1',
      name: 'test openai credential',
      adapterType: 'passthrough',
      baseUrl: upstreamBaseUrl,
      apiKeyEncrypted: encrypt('sk-fake'),
      enabled: true,
      createdAt: now,
    })
    .run();

  db.insert(schema.modelDeployments)
    .values({
      id: 'dep-1',
      credentialId: 'cred-1',
      publicModelName: 'gpt-4o-test',
      providerModelId: 'gpt-4o-provider',
      priority: 0,
      inputCostPerMillion: 2.5,
      outputCostPerMillion: 10,
      enabled: true,
      healthStatus: 'unknown',
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(schema.credentials)
    .values({
      id: 'cred-2',
      name: 'test fallback credential',
      adapterType: 'passthrough',
      baseUrl: secondaryUpstreamBaseUrl,
      apiKeyEncrypted: encrypt('sk-fake-2'),
      enabled: true,
      createdAt: now,
    })
    .run();

  // 專門給 Fallback 測試用的一組獨立 public_model_name，避免跟上面
  // 'gpt-4o-test' 的單一候選測試互相干擾。primary 用 cred-1（fakeUpstream），
  // secondary 用 cred-2（secondaryUpstream），兩邊 handler 可以各自獨立控制。
  db.insert(schema.modelDeployments)
    .values({
      id: 'dep-fallback-primary',
      credentialId: 'cred-1',
      publicModelName: 'gpt-4o-fallback-test',
      providerModelId: 'gpt-4o-primary-provider',
      priority: 0,
      inputCostPerMillion: 2.5,
      outputCostPerMillion: 10,
      enabled: true,
      healthStatus: 'unknown',
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(schema.modelDeployments)
    .values({
      id: 'dep-fallback-secondary',
      credentialId: 'cred-2',
      publicModelName: 'gpt-4o-fallback-test',
      providerModelId: 'gpt-4o-secondary-provider',
      priority: 1,
      inputCostPerMillion: 1,
      outputCostPerMillion: 5,
      enabled: true,
      healthStatus: 'unknown',
      createdAt: now,
      updatedAt: now,
    })
    .run();

  db.insert(schema.apiKeys)
    .values({
      id: 'api-key-1',
      name: 'test gateway key',
      keyHash: defaultTestKey.hash,
      keyPrefix: defaultTestKey.prefix,
      enabled: true,
      allowedModels: null,
      budgetLimit: null,
      currentSpend: 0,
      budgetResetDay: null,
      lastResetAt: null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

seed();

async function startServer() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://localhost:${port}` };
}

test('POST /v1/chat/completions 缺少/錯誤的 Authorization header 回 401', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as any;
    assert.equal(body.error.type, 'authentication_error');
  } finally {
    server.close();
  }
});

test('POST /v1/chat/completions 成功時組出 OpenAI-shape response、帶 x-request-id、寫入 request_logs', async () => {
  upstreamHandler = (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'hi there' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  };

  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-test', messages: [{ role: 'user', content: 'hi' }] }),
    });

    assert.equal(res.status, 200);
    const requestId = res.headers.get('x-request-id');
    assert.ok(requestId);

    const body = (await res.json()) as any;
    assert.equal(body.id, `chatcmpl-${requestId}`);
    assert.equal(body.model, 'gpt-4o-test');
    assert.equal(body.choices[0].message.content, 'hi there');
    assert.deepEqual(body.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });

    const log = db.select().from(schema.requestLogs).where(eq(schema.requestLogs.requestId, requestId!)).get();
    assert.ok(log, 'request_logs 應該有一筆對應 requestId 的紀錄');
    assert.equal(log?.status, 'success');
    assert.equal(log?.publicModelName, 'gpt-4o-test');
    assert.equal(log?.providerModelId, 'gpt-4o-provider');
    assert.equal(log?.inputTokens, 10);
    assert.equal(log?.outputTokens, 5);
    // cost = (10/1e6)*2.5 + (5/1e6)*10 = 0.000025 + 0.00005 = 0.000075
    assert.ok(log && Math.abs(log.cost - 0.000075) < 1e-9);
  } finally {
    server.close();
  }
});

test('POST /v1/chat/completions model 不存在時回 404，且不寫入 request_logs', async () => {
  // 其他測試案例（在同一個 in-memory db 上）可能已經寫過幾筆 log，這裡看的
  // 是「這次請求前後的 log 筆數差」而非絕對筆數，避免跟測試執行順序耦合。
  const countBefore = db.select().from(schema.requestLogs).all().length;

  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'does-not-exist', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as any;
    assert.match(body.error.message, /not configured or disabled/);

    const countAfter = db.select().from(schema.requestLogs).all().length;
    assert.equal(countAfter, countBefore, '路由解析失敗不應該寫 log，因為沒有 deployment context 可以附著');
  } finally {
    server.close();
  }
});

test('POST /v1/chat/completions stream:true 回 400', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-test', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.match(body.error.message, /streaming not supported/);
  } finally {
    server.close();
  }
});

test('POST /v1/chat/completions Content-Type 不是 application/json 時回乾淨的 400，不是 500', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      // 故意不帶 Content-Type：express.json() 不會處理 body，req.body 會是
      // undefined，下游直接取欄位不擋就會噴 TypeError 變成 500。
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.error.type, 'invalid_request_error');
    assert.match(body.error.message, /Content-Type/);
  } finally {
    server.close();
  }
});

test('POST /v1/chat/completions 上游失敗時回 502，且寫入 status=error 的 request_logs', async () => {
  upstreamHandler = (_req, res) => {
    res.writeHead(429, { 'Content-Type': 'text/plain' });
    res.end('rate limited');
  };

  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 502);
    const requestId = res.headers.get('x-request-id');
    const body = (await res.json()) as any;
    assert.equal(body.error.type, 'upstream_error');
    // 只有一筆候選（沒有 Fallback 鏈可言），不該帶 all_candidates_failed
    // 那組欄位——那組欄位是專門標記「候補鏈用盡」的，跟這裡的「本來就只
    // 有一個 model、它失敗了」是不同情境。
    assert.equal(body.error.code, undefined);
    assert.equal(body.error.fallbackExhausted, undefined);

    const log = db.select().from(schema.requestLogs).where(eq(schema.requestLogs.requestId, requestId!)).get();
    assert.ok(log);
    assert.equal(log?.status, 'error');
    assert.equal(log?.cost, 0);
    assert.equal(log?.errorCode, 'upstream_error');
  } finally {
    server.close();
  }
});

test('POST /v1/chat/completions Fallback：primary 失敗、secondary 成功時整體回 200，log 記到 fallbackUsed=true', async () => {
  upstreamHandler = (_req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('primary is down');
  };
  secondaryUpstreamHandler = (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'from secondary' } }], usage: { prompt_tokens: 8, completion_tokens: 4 } }));
  };

  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-fallback-test', messages: [{ role: 'user', content: 'hi' }] }),
    });

    assert.equal(res.status, 200);
    const requestId = res.headers.get('x-request-id');
    const body = (await res.json()) as any;
    assert.equal(body.choices[0].message.content, 'from secondary');

    const log = db.select().from(schema.requestLogs).where(eq(schema.requestLogs.requestId, requestId!)).get();
    assert.ok(log);
    assert.equal(log?.status, 'success');
    assert.equal(log?.deploymentId, 'dep-fallback-secondary');
    assert.equal(log?.providerModelId, 'gpt-4o-secondary-provider');
    assert.equal(log?.fallbackUsed, true);
    assert.equal(log?.fallbackAttempts, 2);
  } finally {
    server.close();
  }
});

test('POST /v1/chat/completions Fallback：全部候選都失敗時回最後一筆（secondary）的錯誤，且只寫一筆 log', async () => {
  upstreamHandler = (_req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('primary is down');
  };
  secondaryUpstreamHandler = (_req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('secondary is also down');
  };

  const countBefore = db.select().from(schema.requestLogs).all().length;

  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-fallback-test', messages: [{ role: 'user', content: 'hi' }] }),
    });

    assert.equal(res.status, 502);
    const requestId = res.headers.get('x-request-id');
    const body = (await res.json()) as any;
    // 502 body 帶的應該是「最後一筆」候選（secondary）的錯誤——502 狀態碼
    // 對得上，但 message 刻意不含上游回應原文（見 errors.ts 的
    // UpstreamProviderError：.message 只留安全的泛用文字，原始上游內容不
    // 直接回給 client 也不落地存進 error_message，避免夾帶敏感內容外洩）。
    assert.equal(body.error.message, 'Provider error: 503');
    // 候補鏈用盡（不只這一筆失敗，前面的候選也都失敗過）要額外標記出來，
    // 讓呼叫端不用自己比對 fallbackAttempts 才能分辨「這是候補全部失敗」
    // 還是「單一 model 失敗」。
    assert.equal(body.error.code, 'all_candidates_failed');
    assert.equal(body.error.fallbackExhausted, true);
    assert.equal(body.error.attemptedCandidates, 2);

    const countAfter = db.select().from(schema.requestLogs).all().length;
    assert.equal(countAfter, countBefore + 1, '全部候選失敗也只應該寫一筆 log（最終結果），不是每次嘗試都寫');

    const log = db.select().from(schema.requestLogs).where(eq(schema.requestLogs.requestId, requestId!)).get();
    assert.ok(log);
    assert.equal(log?.status, 'error');
    assert.equal(log?.deploymentId, 'dep-fallback-secondary');
    assert.equal(log?.fallbackUsed, true);
    assert.equal(log?.fallbackAttempts, 2);
    assert.equal(log?.errorMessage, 'Provider error: 503');
    assert.equal(log?.errorCode, 'all_candidates_failed', 'log 裡的 errorCode 也要能區分候補用盡 vs 單一 model 失敗');
  } finally {
    server.close();
  }
});

test('POST /v1/chat/completions 上游錯誤回應是 JSON 時，provider_error 遮罩敏感欄位，且不流入 error_message／client 回應', async () => {
  upstreamHandler = (_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key', api_key: 'sk-leaked-secret-value' } }));
  };

  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-test', messages: [{ role: 'user', content: 'hi' }] }),
    });

    assert.equal(res.status, 502);
    const requestId = res.headers.get('x-request-id');
    const body = (await res.json()) as any;
    // client 回應不該看到上游原始 JSON 內容，只有安全的泛用訊息。
    assert.equal(body.error.message, 'Provider error: 401');
    assert.ok(!JSON.stringify(body).includes('sk-leaked-secret-value'));

    const log = db.select().from(schema.requestLogs).where(eq(schema.requestLogs.requestId, requestId!)).get();
    assert.ok(log);
    assert.equal(log?.errorMessage, 'Provider error: 401');
    // provider_error 保留了結構化細節方便診斷，但 api_key 欄位要被遮罩掉。
    const providerError = log?.providerError as any;
    assert.equal(providerError?.error?.message, 'invalid api key');
    assert.equal(providerError?.error?.api_key, '[REDACTED]');
  } finally {
    server.close();
  }
});

// @article topic:error-message-scrub-bypass
// code review 2026-09-23 抓到的問題：上游回 200 但形狀不對（例如回了
// tool-call 回應，沒有 message.content）時，PassthroughAdapter 原本直接
// `throw new Error(\`...${JSON.stringify(data)}\`)`，跟上面「上游回非
// 2xx」那個案例不一樣，完全繞過 scrubSensitive() 遮罩，把整段上游回應
// 原封不動塞進 client 看到的 error.message 跟 request_logs.error_message。
// 這個測試刻意在「形狀不對的回應」裡也夾帶一個看起來敏感的欄位，證明修
// 好之後這個情境也會被正確遮罩，不是只有非 2xx 那個分支有保護。
test('POST /v1/chat/completions 上游回 200 但形狀不對（例如 tool-call 回應）時，同樣不能把原始回應洩漏到 client／log', async () => {
  upstreamHandler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // 沒有 message.content（模擬 tool-call 回應），刻意夾帶一個敏感欄位
    // 證明遮罩機制對這個分支也生效。
    res.end(
      JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [{ id: 'call_1' }] } }],
        api_key: 'sk-leaked-from-malformed-response',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
  };

  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-test', messages: [{ role: 'user', content: 'hi' }] }),
    });

    assert.equal(res.status, 502);
    const requestId = res.headers.get('x-request-id');
    const body = (await res.json()) as any;
    assert.equal(body.error.message, 'Unexpected response shape from provider', 'client 不該看到完整的原始上游回應');
    assert.ok(!JSON.stringify(body).includes('sk-leaked-from-malformed-response'));

    const log = db.select().from(schema.requestLogs).where(eq(schema.requestLogs.requestId, requestId!)).get();
    assert.equal(log?.errorMessage, 'Unexpected response shape from provider');
    const providerError = log?.providerError as any;
    assert.equal(providerError?.api_key, '[REDACTED]', 'provider_error 裡的結構化內容還是要留著方便診斷，只是敏感欄位要遮罩');
    assert.equal(providerError?.choices?.[0]?.message?.tool_calls?.[0]?.id, 'call_1');
  } finally {
    server.close();
  }
});

test('POST /v1/chat/completions log 寫入失敗時仍回傳成功結果給 client，不吞掉已經成功的上游回應', async () => {
  upstreamHandler = (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'hi despite log failure' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  };

  // 模擬 recordRequestLog() 寫入失敗（DB 忙碌/唯讀等）：query_only 讓任何
  // INSERT/UPDATE 都直接拋錯，藉此驗證「log 寫不進去不該吞掉已經成功拿到
  // 的上游回應」這個修法。
  sqlite.pragma('query_only = ON');
  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-test', messages: [{ role: 'user', content: 'hi' }] }),
    });

    assert.equal(res.status, 200, 'log 寫入失敗不該讓已經成功的請求變成 500/502');
    const body = (await res.json()) as any;
    assert.equal(body.choices[0].message.content, 'hi despite log failure');
  } finally {
    sqlite.pragma('query_only = OFF');
    server.close();
  }
});

// @article topic:api-key-layer
// 以下測試專門補 Gateway API Key 層本身的行為（08-api-key-layer.md），
// 跟上面沿用 defaultTestKey 的既有 Gateway 行為測試分開：停用/過期/額度
// 用完/模型不在白名單，四種拒絕情況各自要有獨立的 key 設定才測得出來。

test('POST /v1/chat/completions 用被停用的 API key 回 401，且不寫入 request_logs', async () => {
  const now = new Date().toISOString();
  const disabledKey = generateApiKey();
  db.insert(schema.apiKeys)
    .values({
      id: 'api-key-disabled',
      name: 'disabled key',
      keyHash: disabledKey.hash,
      keyPrefix: disabledKey.prefix,
      enabled: false,
      allowedModels: null,
      budgetLimit: null,
      currentSpend: 0,
      budgetResetDay: null,
      lastResetAt: null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const { server, baseUrl } = await startServer();
  try {
    const countBefore = db.select().from(schema.requestLogs).all().length;
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${disabledKey.plaintext}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as any;
    assert.equal(body.error.type, 'authentication_error');
    const countAfter = db.select().from(schema.requestLogs).all().length;
    assert.equal(countAfter, countBefore, '被拒絕的請求不該寫入 request_logs');
  } finally {
    server.close();
  }
});

test('POST /v1/chat/completions 用過期的 API key 回 401', async () => {
  const now = new Date().toISOString();
  const expiredKey = generateApiKey();
  db.insert(schema.apiKeys)
    .values({
      id: 'api-key-expired',
      name: 'expired key',
      keyHash: expiredKey.hash,
      keyPrefix: expiredKey.prefix,
      enabled: true,
      allowedModels: null,
      budgetLimit: null,
      currentSpend: 0,
      budgetResetDay: null,
      lastResetAt: null,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${expiredKey.plaintext}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as any;
    assert.equal(body.error.type, 'authentication_error');
  } finally {
    server.close();
  }
});

test('POST /v1/chat/completions 已超過額度上限的 API key 回 429 insufficient_quota，且不寫入 request_logs', async () => {
  const now = new Date().toISOString();
  const overBudgetKey = generateApiKey();
  db.insert(schema.apiKeys)
    .values({
      id: 'api-key-over-budget',
      name: 'over budget key',
      keyHash: overBudgetKey.hash,
      keyPrefix: overBudgetKey.prefix,
      enabled: true,
      allowedModels: null,
      budgetLimit: 1,
      currentSpend: 1,
      budgetResetDay: null,
      lastResetAt: null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const { server, baseUrl } = await startServer();
  try {
    const countBefore = db.select().from(schema.requestLogs).all().length;
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${overBudgetKey.plaintext}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 429);
    const body = (await res.json()) as any;
    assert.equal(body.error.type, 'insufficient_quota');
    const countAfter = db.select().from(schema.requestLogs).all().length;
    assert.equal(countAfter, countBefore, '被拒絕的請求不該寫入 request_logs');
  } finally {
    server.close();
  }
});

test('POST /v1/chat/completions 要打的 model 不在 API key 的 allowedModels 白名單裡時回 403 permission_error', async () => {
  const now = new Date().toISOString();
  const restrictedKey = generateApiKey();
  db.insert(schema.apiKeys)
    .values({
      id: 'api-key-restricted',
      name: 'model restricted key',
      keyHash: restrictedKey.hash,
      keyPrefix: restrictedKey.prefix,
      enabled: true,
      allowedModels: ['some-other-model'],
      budgetLimit: null,
      currentSpend: 0,
      budgetResetDay: null,
      lastResetAt: null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${restrictedKey.plaintext}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as any;
    assert.equal(body.error.type, 'permission_error');
  } finally {
    server.close();
  }
});

test('POST /v1/chat/completions 要打的 model 有在 allowedModels 白名單裡時放行，且成功請求後 current_spend 會累加', async () => {
  upstreamHandler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
  };

  const now = new Date().toISOString();
  const allowedKey = generateApiKey();
  db.insert(schema.apiKeys)
    .values({
      id: 'api-key-allowed',
      name: 'model allowed key',
      keyHash: allowedKey.hash,
      keyPrefix: allowedKey.prefix,
      enabled: true,
      allowedModels: ['gpt-4o-test'],
      budgetLimit: null,
      currentSpend: 0,
      budgetResetDay: null,
      lastResetAt: null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const { server, baseUrl } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${allowedKey.plaintext}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-test', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);

    const row = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, 'api-key-allowed')).get();
    assert.ok(row);
    assert.ok(row!.currentSpend > 0, '成功請求後 current_spend 應該從 0 累加成正值');
  } finally {
    server.close();
  }
});

// @article topic:api-key-layer
// code review 抓到的 TOCTOU 競態迴歸測試：requireGatewayKey 檢查額度到
// chat.routes.ts 真正呼叫 incrementSpend() 之間隔著一次 await 上游的空
// 窗期，修好之前，同一把 key 平行送出多個請求會各自看到「更新前」的
// current_spend 一起通過檢查，加總後遠超過 budget_limit。這裡刻意校準
// 成單筆請求花費 2.5、budgetLimit=2（第一筆檢查時 current_spend=0 < 2
// 會過，累加後變 2.5；第二筆如果序列化正確，會看到已經是 2.5 >= 2 被擋
// 下）。
test('POST /v1/chat/completions 同一把 key 平行送出多個請求時，額度檢查依序序列化，不會一起通過導致總花費超過上限', async () => {
  upstreamHandler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }));
  };

  const now = new Date().toISOString();
  const concurrentKey = generateApiKey();
  db.insert(schema.apiKeys)
    .values({
      id: 'api-key-concurrency-test',
      name: 'concurrency test key',
      keyHash: concurrentKey.hash,
      keyPrefix: concurrentKey.prefix,
      enabled: true,
      allowedModels: null,
      // dep-1（gpt-4o-test）的 inputCostPerMillion=2.5，1,000,000 input
      // token、0 output token 剛好花費 2.5——budgetLimit=2 只夠放行一筆。
      budgetLimit: 2,
      currentSpend: 0,
      budgetResetDay: null,
      lastResetAt: null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const { server, baseUrl } = await startServer();
  try {
    const makeRequest = () =>
      fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${concurrentKey.plaintext}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-test', messages: [{ role: 'user', content: 'hi' }] }),
      });

    const [resA, resB] = await Promise.all([makeRequest(), makeRequest()]);
    const statuses = [resA.status, resB.status].sort();
    assert.deepEqual(statuses, [200, 429], '兩個平行請求應該剛好一個成功、一個因為額度不足被擋下，不能兩個都成功');

    const row = db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, 'api-key-concurrency-test')).get();
    assert.ok(
      row!.currentSpend < 5,
      `current_spend (${row!.currentSpend}) 不該累加成兩筆請求的總和——若序列化正確，只有一筆真的打進上游並計費`,
    );
  } finally {
    server.close();
  }
});
