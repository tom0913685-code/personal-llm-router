import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassthroughAdapter } from './passthrough-adapter.js';
import { UpstreamProviderError } from '../errors.js';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('chat() 打 {baseUrl}/chat/completions，帶 Bearer header', async (t) => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;

  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return jsonResponse({
      choices: [{ message: { content: 'hello' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  });

  const adapter = new PassthroughAdapter({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
  const result = await adapter.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(capturedUrl, 'https://api.openai.com/v1/chat/completions');
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(result, {
    content: 'hello',
    usage: { inputTokens: 10, outputTokens: 5 },
    raw: { choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
  });
});

test('chat() 有 system 時會插入 system 訊息在 messages 最前面', async (t) => {
  let sentBody: any;

  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    sentBody = JSON.parse(init.body as string);
    return jsonResponse({ choices: [{ message: { content: 'ok' } }], usage: {} });
  });

  const adapter = new PassthroughAdapter({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
  await adapter.chat({ model: 'gpt-4o', system: 'be nice', messages: [{ role: 'user', content: 'hi' }] });

  assert.deepEqual(sentBody.messages, [
    { role: 'system', content: 'be nice' },
    { role: 'user', content: 'hi' },
  ]);
});

test('chat() 在上游回傳非 2xx 時拋出錯誤', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ error: 'bad request' }, { status: 400 }));

  const adapter = new PassthroughAdapter({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
  await assert.rejects(
    adapter.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    /Provider error: 400/,
  );
});

test('chat() 在回應缺少 choices[0].message 時拋出錯誤', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ unexpected: true }));

  const adapter = new PassthroughAdapter({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
  await assert.rejects(
    adapter.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
    /Unexpected response shape/,
  );
});

// @article topic:error-message-scrub-bypass
// code review 2026-09-23 抓到的問題：形狀不對的回應原本直接
// `throw new Error(\`...${JSON.stringify(data)}\`)`，把完整回應塞進
// .message，繞過 chat.routes.ts 賴以遮罩敏感內容的 UpstreamProviderError
// /.providerDetail 分離設計。這裡直接在 adapter 層驗證：拋出的必須是
// UpstreamProviderError，.message 只能是安全的泛用文字，原始資料要放進
// .providerDetail 而不是編進 .message 字串裡。
test('chat() 在回應形狀不對時拋出 UpstreamProviderError，.message 是安全泛用文字，原始資料放在 .providerDetail 不會編進 .message', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse({ choices: [{ message: { content: null } }], api_key: 'sk-should-not-leak-into-message' }),
  );

  const adapter = new PassthroughAdapter({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
  try {
    await adapter.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    assert.fail('應該要拋出錯誤');
  } catch (err) {
    assert.ok(err instanceof UpstreamProviderError, '應該是 UpstreamProviderError，不是裸的 Error');
    assert.equal(err.message, 'Unexpected response shape from provider');
    assert.ok(!err.message.includes('sk-should-not-leak-into-message'), '.message 不該包含原始回應內容');
    assert.equal((err.providerDetail as any)?.api_key, 'sk-should-not-leak-into-message', '原始資料要放在 .providerDetail，交給呼叫端過 scrubSensitive() 才使用');
  }
});

test('ping() 打 {baseUrl}/models，回傳 latencyMs', async (t) => {
  let capturedUrl: string | undefined;

  t.mock.method(globalThis, 'fetch', async (url: string) => {
    capturedUrl = url;
    return jsonResponse({ data: [] });
  });

  const adapter = new PassthroughAdapter({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
  const result = await adapter.ping();

  assert.equal(capturedUrl, 'https://api.openai.com/v1/models');
  assert.equal(typeof result.latencyMs, 'number');
});

test('ping() 在上游回傳非 2xx 時拋出錯誤', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({}, { status: 401 }));

  const adapter = new PassthroughAdapter({ baseUrl: 'https://api.openai.com/v1', apiKey: 'bad-key' });
  await assert.rejects(adapter.ping(), /Health check failed: 401/);
});
