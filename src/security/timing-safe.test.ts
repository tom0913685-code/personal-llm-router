import { test } from 'node:test';
import assert from 'node:assert/strict';
import { timingSafeStringEqual } from './timing-safe.js';

test('timingSafeStringEqual() 同樣的字串回傳 true', () => {
  assert.equal(timingSafeStringEqual('secret-value', 'secret-value'), true);
});

test('timingSafeStringEqual() 不同的字串回傳 false', () => {
  assert.equal(timingSafeStringEqual('secret-value', 'secret-valuf'), false);
});

test('timingSafeStringEqual() 長度不同的字串回傳 false，不會像 timingSafeEqual() 原生 API 那樣因長度不同直接拋例外', () => {
  assert.doesNotThrow(() => timingSafeStringEqual('short', 'a-much-longer-string'));
  assert.equal(timingSafeStringEqual('short', 'a-much-longer-string'), false);
});

test('timingSafeStringEqual() 空字串邊界情況', () => {
  assert.equal(timingSafeStringEqual('', ''), true);
  assert.equal(timingSafeStringEqual('', 'x'), false);
});
