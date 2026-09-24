import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicAdapter } from './anthropic-adapter.js';
import { UpstreamProviderError } from '../errors.js';

// 跟 passthrough-adapter.test.ts 用同一招：mock globalThis.fetch，不需要真
// 的網路/API key。Anthropic SDK 的 fetch 是在建構 client 當下才決議
// （`options.fetch ?? Shims.getDefaultFetch()`，見
// node_modules/@anthropic-ai/sdk/internal/shims.js 的 getDefaultFetch()
// 直接讀 global `fetch` binding），所以只要在 `new AnthropicAdapter(...)`
// 之前把 globalThis.fetch mock 好，SDK 內部就會用到 mock 版本。
function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('chat() 成功時回傳 content/usage，system 跟 messages 正確傳給 SDK', async (t) => {
  let capturedBody: any;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string);
    return jsonResponse({
      id: 'msg_test123',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hello there' }],
      model: 'claude-test',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 34 },
    });
  });

  const adapter = new AnthropicAdapter('sk-ant-fake-key');
  const result = await adapter.chat({
    model: 'claude-test',
    system: 'be nice',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(capturedBody.system, 'be nice');
  assert.deepEqual(capturedBody.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(result.content, 'hello there');
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 34 });
});

test('chat() 沒帶 maxTokens 時預設 1024', async (t) => {
  let capturedBody: any;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string);
    return jsonResponse({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      model: 'claude-test',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });

  const adapter = new AnthropicAdapter('sk-ant-fake-key');
  await adapter.chat({ model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(capturedBody.max_tokens, 1024);
});

test('chat() 上游回傳錯誤時拋出 UpstreamProviderError，.message 是安全泛用文字，.providerDetail 帶結構化細節', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse(
      { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key: sk-ant-should-not-leak-in-message' } },
      { status: 401 },
    ),
  );

  const adapter = new AnthropicAdapter('sk-ant-fake-key');
  await assert.rejects(
    adapter.chat({ model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] }),
    (err: unknown) => {
      assert.ok(err instanceof UpstreamProviderError);
      // .message 是我們自己組的安全泛用文字，不含上游回應原文——跟
      // passthrough-adapter 修的同一個洩漏風險（見 errors.ts 的說明）。
      assert.equal(err.message, 'Provider error: 401');
      assert.ok(!err.message.includes('sk-ant-should-not-leak-in-message'));
      // .providerDetail 保留原始結構化內容供呼叫端自行 scrub 後使用。
      assert.equal((err.providerDetail as any)?.error?.type, 'authentication_error');
      assert.match((err.providerDetail as any)?.error?.message ?? '', /sk-ant-should-not-leak-in-message/);
      return true;
    },
  );
});

test('chat() 回應沒有 text content block（例如被 max_tokens 截斷）時明確拋錯，不安靜回空字串', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse({
      id: 'msg_truncated',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-test',
      stop_reason: 'max_tokens',
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 1 },
    }),
  );

  const adapter = new AnthropicAdapter('sk-ant-fake-key');
  await assert.rejects(
    adapter.chat({ model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] }),
    /Unexpected response shape: no text content block \(stop_reason=max_tokens\)/,
  );
});

test('ping() 成功時回傳 latencyMs', async (t) => {
  let capturedUrl: string | undefined;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    capturedUrl = url;
    return jsonResponse({ data: [], has_more: false, first_id: null, last_id: null });
  });

  const adapter = new AnthropicAdapter('sk-ant-fake-key');
  const result = await adapter.ping();

  assert.match(capturedUrl ?? '', /\/v1\/models/);
  assert.equal(typeof result.latencyMs, 'number');
});

test('ping() 上游回傳錯誤時拋出 UpstreamProviderError，.message 是安全泛用文字', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    jsonResponse({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 }),
  );

  const adapter = new AnthropicAdapter('sk-ant-fake-key');
  await assert.rejects(adapter.ping(), (err: unknown) => {
    assert.ok(err instanceof UpstreamProviderError);
    assert.equal(err.message, 'Health check failed: 401');
    assert.equal((err.providerDetail as any)?.error?.type, 'authentication_error');
    return true;
  });
});

test('AnthropicAdapter 建構後具備 chat/ping 方法', () => {
  const adapter = new AnthropicAdapter('sk-ant-fake-key-for-construction-only');
  assert.equal(typeof adapter.chat, 'function');
  assert.equal(typeof adapter.ping, 'function');
});
