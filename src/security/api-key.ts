import { randomBytes, createHash } from 'node:crypto';

// 08-api-key-layer.md 已定案：sk- 開頭接隨機 hex（使用者 2026-09-19 確認
// 這個前綴），長度跟這個專案其他隨機金鑰（ENCRYPTION_KEY、
// SITE_SESSION_SECRET）一致用 32 bytes（64 hex 字元），保持同等強度。
const KEY_PREFIX = 'sk-';
const RANDOM_BYTES_LENGTH = 32;
// key_prefix 存到 DB、顯示在清單畫面用——使用者確認存 "sk-" 後面接 7 個
// 字元（例如 sk-3f9a2b1），只夠辨識、猜不出剩下的部分。
const DISPLAY_PREFIX_LENGTH = 7;

export interface GeneratedApiKey {
  plaintext: string;
  hash: string;
  prefix: string;
}

// 產生一組新的明文 key + 對應的雜湊跟顯示用前綴。明文只在這裡短暫存在，
// 呼叫端要在回應裡回傳一次給使用者複製，之後只存 hash/prefix，不落地明文。
export function generateApiKey(): GeneratedApiKey {
  const random = randomBytes(RANDOM_BYTES_LENGTH).toString('hex');
  const plaintext = `${KEY_PREFIX}${random}`;
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    prefix: `${KEY_PREFIX}${random.slice(0, DISPLAY_PREFIX_LENGTH)}`,
  };
}

// 跟 Credential 的 api_key 不同（那個要能解密拿去打上游），這把 key 從頭
// 到尾只需要比對，用 SHA-256 雜湊儲存，不可逆——見
// docs/requirements/08-api-key-layer.md「已定案」。
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}
