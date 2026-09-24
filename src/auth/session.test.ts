import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionToken, verifySessionToken } from './session.js';

test('createSessionToken() 產生的 token 可以用同一把 secret 驗證通過', async () => {
  const secret = 'test-secret-value';
  const token = await createSessionToken(secret);
  assert.equal(await verifySessionToken(secret, token), true);
});

test('verifySessionToken() 用錯的 secret 驗證失敗', async () => {
  const token = await createSessionToken('correct-secret');
  assert.equal(await verifySessionToken('wrong-secret', token), false);
});

test('verifySessionToken() 沒有 token 時回傳 false', async () => {
  assert.equal(await verifySessionToken('any-secret', undefined), false);
});

test('verifySessionToken() token 被竄改時驗證失敗', async () => {
  const secret = 'test-secret-value';
  const token = await createSessionToken(secret);
  assert.equal(await verifySessionToken(secret, `${token}x`), false);
});

test('verifySessionToken() 格式不對（缺分隔點）時回傳 false，不拋例外', async () => {
  assert.equal(await verifySessionToken('any-secret', 'not-a-valid-token'), false);
});

test('verifySessionToken() 過期的 token 驗證失敗', async () => {
  const secret = 'test-secret-value';
  // 直接組一個「已經過期」的 token，繞過 createSessionToken() 固定 7 天
  // 的 TTL——用跟 session.ts 一樣的簡易 base64url + Web Crypto HMAC 手法。
  function base64UrlEncode(bytes: Uint8Array): string {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return Buffer.from(binary, 'binary').toString('base64url');
  }

  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ exp: Date.now() - 1000 })));
  const { webcrypto } = await import('node:crypto');
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  const expiredToken = `${payloadB64}.${base64UrlEncode(new Uint8Array(signature))}`;

  assert.equal(await verifySessionToken(secret, expiredToken), false);
});
