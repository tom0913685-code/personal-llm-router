import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderAdapter } from './factory.js';
import { PassthroughAdapter } from './passthrough-adapter.js';
import { AnthropicAdapter } from './anthropic-adapter.js';

test('adapterType: passthrough 帶 baseUrl 時回傳 PassthroughAdapter', () => {
  const adapter = createProviderAdapter({ adapterType: 'passthrough', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' });
  assert.ok(adapter instanceof PassthroughAdapter);
});

test('adapterType: passthrough 沒帶 baseUrl 時拋出錯誤', () => {
  assert.throws(
    () => createProviderAdapter({ adapterType: 'passthrough', apiKey: 'sk-test' }),
    /Passthrough adapter requires baseUrl/,
  );
});

test('adapterType: anthropic_native 回傳 AnthropicAdapter', () => {
  const adapter = createProviderAdapter({ adapterType: 'anthropic_native', apiKey: 'sk-ant-test' });
  assert.ok(adapter instanceof AnthropicAdapter);
});

test('未知的 adapterType 拋出錯誤', () => {
  assert.throws(
    // @ts-expect-error 刻意傳入不合法的 adapterType 測試執行期防呆
    () => createProviderAdapter({ adapterType: 'unknown', apiKey: 'sk-test' }),
    /Unknown adapter type: unknown/,
  );
});
