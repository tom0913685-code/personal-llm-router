import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toUnifiedChatRequest, toOpenAiChatResponse, toOpenAiErrorBody } from './translate.js';

test('toUnifiedChatRequest() 把 system 訊息拆出來，其餘留在 messages', () => {
  const result = toUnifiedChatRequest(
    {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    },
    'gpt-4o-provider-id',
  );

  assert.equal(result.model, 'gpt-4o-provider-id');
  assert.equal(result.system, 'be nice');
  assert.deepEqual(result.messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
});

test('toUnifiedChatRequest() 多個 system 訊息會合併', () => {
  const result = toUnifiedChatRequest(
    {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'first' },
        { role: 'system', content: 'second' },
        { role: 'user', content: 'hi' },
      ],
    },
    'x',
  );
  assert.equal(result.system, 'first\n\nsecond');
});

test('toUnifiedChatRequest() 沒有 system 訊息時 system 是 undefined', () => {
  const result = toUnifiedChatRequest({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }, 'x');
  assert.equal(result.system, undefined);
});

test('toUnifiedChatRequest() 帶入 max_tokens/temperature', () => {
  const result = toUnifiedChatRequest(
    { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, temperature: 0.5 },
    'x',
  );
  assert.equal(result.maxTokens, 100);
  assert.equal(result.temperature, 0.5);
});

test('toUnifiedChatRequest() model 缺少時拋出 ValidationError', () => {
  assert.throws(() => toUnifiedChatRequest({ messages: [{ role: 'user', content: 'hi' }] }, 'x'), /model is required/);
});

test('toUnifiedChatRequest() messages 是空陣列時拋出錯誤', () => {
  assert.throws(() => toUnifiedChatRequest({ model: 'gpt-4o', messages: [] }, 'x'), /non-empty array/);
});

test('toUnifiedChatRequest() 不支援的 role（如 tool）會拋出明確錯誤', () => {
  assert.throws(
    () => toUnifiedChatRequest({ model: 'gpt-4o', messages: [{ role: 'tool', content: 'x' }] }, 'x'),
    /unsupported message role "tool"/,
  );
});

test('toUnifiedChatRequest() 只有 system 訊息、沒有 user/assistant 時拋出錯誤', () => {
  assert.throws(
    () => toUnifiedChatRequest({ model: 'gpt-4o', messages: [{ role: 'system', content: 'x' }] }, 'x'),
    /at least one user\/assistant message/,
  );
});

test('toOpenAiChatResponse() 組出 OpenAI-shape 的 chat.completion', () => {
  const response = toOpenAiChatResponse('req-1', 'gpt-4o', {
    content: 'hello there',
    usage: { inputTokens: 10, outputTokens: 5 },
    raw: {},
  });

  assert.equal(response.id, 'chatcmpl-req-1');
  assert.equal(response.object, 'chat.completion');
  assert.equal(response.model, 'gpt-4o');
  assert.deepEqual(response.choices, [
    { index: 0, message: { role: 'assistant', content: 'hello there' }, finish_reason: 'stop' },
  ]);
  assert.deepEqual(response.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
});

test('toOpenAiErrorBody() 組出 { error: { message, type } }', () => {
  assert.deepEqual(toOpenAiErrorBody('bad request', 'invalid_request_error'), {
    error: { message: 'bad request', type: 'invalid_request_error' },
  });
});
