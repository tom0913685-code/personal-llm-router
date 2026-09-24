import { eq } from 'drizzle-orm';
import { createProviderAdapter } from '../adapters/factory.js';
import type { ProviderAdapter } from '../adapters/types.js';
import { decrypt } from '../security/crypto.js';
import { db as defaultDb, schema } from '../db/index.js';
import { NotFoundError } from '../errors.js';

type Db = typeof defaultDb;

// 依 03-routing.md 已定案：Adapter 實例做簡單的 in-memory cache，
// cache key 為 credential_id，避免每次請求都重新解密 api_key 建立新實例。
// Credential 設定變更時要呼叫 invalidateAdapter() 讓對應 cache 失效
// （admin/credentials.routes.ts 的 PATCH handler 會呼叫）。
const cache = new Map<string, ProviderAdapter>();

// @article topic:adapter-cache-race
// 只收 credentialId、cache miss 時自己重新查 DB 拿「當下最新」的 row，
// 不接受呼叫端傳入現成的 credential row 物件——見
// docs/code-review-findings.md 高風險 #5：Fallback 重試迴圈裡，若請求
// 開頭撈到的 credential 快照在中途某個 await 期間被 PATCH 換了新
// api_key（同時觸發 invalidateAdapter），舊寫法會用呼叫端傳入的舊快照
// 重建 adapter、把舊金鑰重新種回 cache，等於讓剛做的 invalidate 白做。
// 改成只信 DB 裡當下的資料，就不會有這個競態窗口。
export function getAdapter(credentialId: string, database: Db = defaultDb): ProviderAdapter {
  const cached = cache.get(credentialId);
  if (cached) return cached;

  const credential = database.select().from(schema.credentials).where(eq(schema.credentials.id, credentialId)).get();
  if (!credential) {
    throw new NotFoundError(`credential ${credentialId} not found`);
  }

  const adapter = createProviderAdapter({
    adapterType: credential.adapterType,
    baseUrl: credential.baseUrl ?? undefined,
    apiKey: decrypt(credential.apiKeyEncrypted),
  });
  cache.set(credentialId, adapter);
  return adapter;
}

export function invalidateAdapter(credentialId: string): void {
  cache.delete(credentialId);
}
