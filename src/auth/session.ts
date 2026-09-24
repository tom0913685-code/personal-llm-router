import { webcrypto } from 'node:crypto';

// Session token 的簽章/驗證邏輯——這份是後端（Express）的版本，前端
// （frontend/src/lib/session.ts）有一份幾乎一樣的複本，兩邊各自 import
// 不到對方（前後端是獨立的兩個 npm package，沒有共用 workspace），演算法
// 必須保持完全一致（同一個 SITE_SESSION_SECRET 簽出來的 token 兩邊都要
// 驗證得過）。只用 Web Crypto API（webcrypto.subtle、btoa/atob），不用
// node:crypto 的 createHash 等傳統 API——Next.js Middleware 預設在 Edge
// Runtime 執行，沒有完整的 node:crypto 可用，兩邊要用同一組跨 runtime
// 都存在的 API 才能保證邏輯一致。見 docs/requirements/06-site-auth.md
// 「實作位置」段落。
//
// Token 格式：`${base64url(JSON.stringify({exp}))}.${base64url(HMAC-SHA256 簽章)}`
// 只帶一個過期時間，沒有使用者 id——這把系統只有一組共用密碼，沒有帳號
// 概念，session 不需要記錄「是誰」。

export const SESSION_COOKIE_NAME = 'site_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天，見 06-site-auth.md 已定案

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importHmacKey(secret: string): Promise<webcrypto.CryptoKey> {
  return webcrypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function createSessionToken(secret: string): Promise<string> {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_TTL_MS });
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payload));
  const key = await importHmacKey(secret);
  const signature = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifySessionToken(secret: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const [payloadB64, sigB64] = token.split('.');
  if (!payloadB64 || !sigB64) return false;

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlDecode(sigB64);
  } catch {
    return false; // 格式不對（不是合法 base64url），視為無效 token，不要讓 atob() 的例外往上炸
  }

  const key = await importHmacKey(secret);
  // webcrypto.subtle.verify() 內部驗證 HMAC 是不是對得上，具備
  // constant-time 特性，不需要另外用 timingSafeStringEqual 包一層。
  const valid = await webcrypto.subtle.verify('HMAC', key, signatureBytes, new TextEncoder().encode(payloadB64));
  if (!valid) return false;

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as { exp?: unknown };
    return typeof payload.exp === 'number' && Date.now() < payload.exp;
  } catch {
    return false;
  }
}
