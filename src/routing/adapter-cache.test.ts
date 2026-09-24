import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { getAdapter, invalidateAdapter } from './adapter-cache.js';
import { encrypt } from '../security/crypto.js';
import { createTestDb, schema } from '../db/test-helpers.js';

process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('hex');

// 兩台假上游，模擬「credential 被 PATCH 前後」各自指向不同的 baseUrl——
// 用實際發出的請求打到哪一台，證明 getAdapter() 重建後真的讀到最新資料，
// 而不是只比較「回傳的物件參照不一樣」這種不夠直接的證據。
let originalHits = 0;
const originalUpstream = http.createServer((_req, res) => {
  originalHits++;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [] }));
});
await new Promise<void>((resolve) => originalUpstream.listen(0, resolve));
const originalBaseUrl = `http://localhost:${(originalUpstream.address() as AddressInfo).port}`;

let rotatedHits = 0;
const rotatedUpstream = http.createServer((_req, res) => {
  rotatedHits++;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ data: [] }));
});
await new Promise<void>((resolve) => rotatedUpstream.listen(0, resolve));
const rotatedBaseUrl = `http://localhost:${(rotatedUpstream.address() as AddressInfo).port}`;

after(() => {
  originalUpstream.close();
  rotatedUpstream.close();
});

function seedCredential(db: ReturnType<typeof createTestDb>['db']) {
  const id = randomUUID();
  db.insert(schema.credentials)
    .values({
      id,
      name: 'test credential',
      adapterType: 'passthrough',
      baseUrl: originalBaseUrl,
      apiKeyEncrypted: encrypt('sk-original'),
      enabled: true,
      createdAt: new Date().toISOString(),
    })
    .run();
  return id;
}

test('getAdapter() cache miss 時查 DB 建立 adapter，cache hit 直接回傳同一個實例', () => {
  const { db } = createTestDb();
  const id = seedCredential(db);

  const first = getAdapter(id, db);
  const second = getAdapter(id, db);

  assert.equal(first, second, 'cache hit 應該回傳同一個 adapter 實例，不是每次都重建');
});

test('getAdapter() 找不到 credential 時拋出 NotFoundError', () => {
  const { db } = createTestDb();
  assert.throws(() => getAdapter('does-not-exist', db), /credential does-not-exist not found/);
});

// @article topic:adapter-cache-race
test('invalidateAdapter() 後 cache miss 重建，重建出來的 adapter 真的用了資料庫裡最新的 baseUrl/api_key', async () => {
  // 直接驗證 code review 高風險 #5 的修法：getAdapter() 只吃 credentialId、
  // cache miss 時自己重新查 DB，不接受呼叫端傳入現成的 credential row 物件
  // ——避免 Fallback 重試流程裡，中途 PATCH 換了新 api_key 之後，被用呼叫
  // 端手上的舊快照重新種回 cache。用「請求真的打到哪一台假上游」證明，
  // 比單純比較物件參照更直接。
  const { db } = createTestDb();
  const id = seedCredential(db);

  const before = getAdapter(id, db);
  await before.ping();
  assert.equal(originalHits, 1, 'invalidate 前應該打到原本的 baseUrl');
  assert.equal(rotatedHits, 0);

  // 模擬 PATCH credential：baseUrl/api_key 換掉，並比照
  // credentials.routes.ts 的 PATCH handler 呼叫 invalidateAdapter()。
  db.update(schema.credentials)
    .set({ baseUrl: rotatedBaseUrl, apiKeyEncrypted: encrypt('sk-rotated') })
    .where(eq(schema.credentials.id, id))
    .run();
  invalidateAdapter(id);

  const after = getAdapter(id, db);
  assert.notEqual(before, after, 'invalidate 後應該重建一個新的 adapter 實例');

  await after.ping();
  assert.equal(rotatedHits, 1, 'invalidate 後重建的 adapter 應該打到 PATCH 後的新 baseUrl');
  assert.equal(originalHits, 1, '不該再打到舊的 baseUrl');
});
