import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.SITE_SESSION_SECRET = randomBytes(32).toString('hex');

const { createApp } = await import('./app.js');
const { sqlite } = await import('./db/index.js');
const { TEST_SCHEMA_SQL } = await import('./db/test-helpers.js');
const { createSessionToken, SESSION_COOKIE_NAME } = await import('./auth/session.js');

sqlite.exec(TEST_SCHEMA_SQL);

const SESSION_TOKEN = await createSessionToken(process.env.SITE_SESSION_SECRET);

async function startServer() {
  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://localhost:${port}` };
}

// @article topic:error-message-scrub-bypass
// code review 2026-09-23 抓到的問題：集中錯誤處理 middleware 原本不管
// err 有沒有 .status 都直接回 err.message，對「真正沒被接住的未預期例
// 外」（沒有 .status，走到預設 500）完全沒有達到註解說的「避免洩漏內部
// 錯誤細節」——只有我們自己的 Error 類別（有明確 .status，訊息是刻意寫
// 的安全文字）才該信任它的 .message。
//
// 用「把 sqlite 連線關掉，讓底下的查詢丟出未經處理的原始例外」模擬一個
// 真正沒被任何路由自己 try/catch 接住的未預期錯誤，不用真的去製造一個
// application bug。
test('未預期的例外（沒有 .status，非自訂 Error 類別）回 500，且 client 看到的是泛用文字，不是原始例外訊息', async () => {
  const { server, baseUrl } = await startServer();
  try {
    sqlite.close();
    const res = await fetch(`${baseUrl}/admin/credentials`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${SESSION_TOKEN}` },
    });
    assert.equal(res.status, 500);
    const body = (await res.json()) as any;
    assert.equal(body.error.message, 'Internal server error', 'client 不該看到 better-sqlite3 丟出的原始例外訊息');
    assert.equal(body.error.type, 'internal_error');
  } finally {
    server.close();
  }
});
