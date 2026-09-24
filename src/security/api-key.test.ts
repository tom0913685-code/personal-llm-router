import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateApiKey, hashApiKey } from './api-key.js';

test('generateApiKey() 產生 sk- 開頭、64 個 hex 字元的明文', () => {
  const { plaintext } = generateApiKey();
  assert.match(plaintext, /^sk-[0-9a-f]{64}$/);
});

test('generateApiKey() 每次呼叫產生不同的明文（隨機性）', () => {
  const a = generateApiKey();
  const b = generateApiKey();
  assert.notEqual(a.plaintext, b.plaintext);
});

test('generateApiKey() 的 hash 等於對明文算 hashApiKey()', () => {
  const { plaintext, hash } = generateApiKey();
  assert.equal(hash, hashApiKey(plaintext));
});

test('generateApiKey() 的 prefix 是 sk- 接明文隨機部分的前 7 碼，猜不出剩下的部分', () => {
  const { plaintext, prefix } = generateApiKey();
  assert.equal(prefix, plaintext.slice(0, 'sk-'.length + 7));
  assert.ok(prefix.length < plaintext.length);
});

test('hashApiKey() 是純函式：同樣輸入永遠得到同樣輸出', () => {
  assert.equal(hashApiKey('sk-abc'), hashApiKey('sk-abc'));
});

test('hashApiKey() 不同輸入產生不同輸出，且等於直接算 SHA-256', () => {
  const expected = createHash('sha256').update('sk-abc').digest('hex');
  assert.equal(hashApiKey('sk-abc'), expected);
  assert.notEqual(hashApiKey('sk-abc'), hashApiKey('sk-abd'));
});
