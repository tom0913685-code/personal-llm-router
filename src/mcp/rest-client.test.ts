import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { adminGet, adminPost, adminPatch, McpRestError } from './rest-client.js';
import { verifySessionToken, SESSION_COOKIE_NAME } from '../auth/session.js';

process.env.SITE_SESSION_SECRET = randomBytes(32).toString('hex');

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('adminGet() 帶的 Cookie 是用 SITE_SESSION_SECRET 簽出來、驗證得過的合法 session token', async (t) => {
  let capturedInit: RequestInit | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    capturedInit = init;
    return jsonResponse({ ok: true });
  });

  await adminGet('/admin/deployments');

  const headers = capturedInit?.headers as Record<string, string>;
  const cookie = headers.Cookie;
  assert.ok(cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
  const token = cookie.slice(`${SESSION_COOKIE_NAME}=`.length);
  assert.equal(await verifySessionToken(process.env.SITE_SESSION_SECRET!, token), true);
});

test('adminGet() 預設打 http://localhost:{PORT}，PORT 沒設定時預設 8787', async (t) => {
  let capturedUrl: string | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    capturedUrl = url;
    return jsonResponse({ ok: true });
  });

  const originalBackendUrl = process.env.BACKEND_URL;
  const originalPort = process.env.PORT;
  delete process.env.BACKEND_URL;
  delete process.env.PORT;
  try {
    await adminGet('/admin/deployments');
    assert.equal(capturedUrl, 'http://localhost:8787/admin/deployments');
  } finally {
    if (originalBackendUrl === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = originalBackendUrl;
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
  }
});

test('adminGet() 有設定 BACKEND_URL 時改用它，不是 localhost', async (t) => {
  let capturedUrl: string | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    capturedUrl = url;
    return jsonResponse({ ok: true });
  });

  const original = process.env.BACKEND_URL;
  process.env.BACKEND_URL = 'http://192.168.1.5:8787';
  try {
    await adminGet('/admin/deployments');
    assert.equal(capturedUrl, 'http://192.168.1.5:8787/admin/deployments');
  } finally {
    if (original === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = original;
  }
});

test('adminPost() / adminPatch() 送出正確的 method 跟 JSON body', async (t) => {
  const captured: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    captured.push({ url, init });
    return jsonResponse({ ok: true });
  });

  await adminPost('/admin/credentials', { name: 'foo' });
  await adminPatch('/admin/credentials/abc', { enabled: false });

  assert.equal(captured[0].init.method, 'POST');
  assert.equal(captured[0].init.body, JSON.stringify({ name: 'foo' }));
  assert.equal(captured[1].url, 'http://localhost:8787/admin/credentials/abc');
  assert.equal(captured[1].init.method, 'PATCH');
  assert.equal(captured[1].init.body, JSON.stringify({ enabled: false }));
});

test('上游回非 2xx 時丟 McpRestError，帶正確 status 跟 body.error.message', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ error: { message: 'credentialId 不存在' } }, { status: 400 }));

  await assert.rejects(
    () => adminPost('/admin/deployments', {}),
    (err: unknown) => {
      assert.ok(err instanceof McpRestError);
      assert.equal(err.status, 400);
      assert.equal(err.message, 'credentialId 不存在');
      return true;
    },
  );
});

test('SITE_SESSION_SECRET 沒設定時丟出清楚的錯誤，不是讓 createSessionToken 內部炸出難懂的例外', async () => {
  const original = process.env.SITE_SESSION_SECRET;
  delete process.env.SITE_SESSION_SECRET;
  try {
    await assert.rejects(() => adminGet('/admin/deployments'), /SITE_SESSION_SECRET/);
  } finally {
    if (original === undefined) delete process.env.SITE_SESSION_SECRET;
    else process.env.SITE_SESSION_SECRET = original;
  }
});
