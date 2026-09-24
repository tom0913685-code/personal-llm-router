import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt } from './crypto.js';

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
});

test('encrypt() 後用 decrypt() 可以還原原始明文', () => {
  const plaintext = 'sk-ant-super-secret-key';
  const ciphertext = encrypt(plaintext);
  assert.notEqual(ciphertext, plaintext);
  assert.equal(decrypt(ciphertext), plaintext);
});

test('同一段明文每次加密結果不同（IV 隨機）', () => {
  const a = encrypt('same-plaintext');
  const b = encrypt('same-plaintext');
  assert.notEqual(a, b);
  assert.equal(decrypt(a), 'same-plaintext');
  assert.equal(decrypt(b), 'same-plaintext');
});

test('ENCRYPTION_KEY 未設定時 encrypt() 拋出明確錯誤', () => {
  delete process.env.ENCRYPTION_KEY;
  assert.throws(() => encrypt('x'), /ENCRYPTION_KEY is not set/);
});

test('ENCRYPTION_KEY 長度不對時拋出明確錯誤', () => {
  process.env.ENCRYPTION_KEY = 'too-short';
  assert.throws(() => encrypt('x'), /must be a 32-byte hex string/);
});
