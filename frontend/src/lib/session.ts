// Session token 的簽章/驗證邏輯——這份是前端（Next.js）的版本，後端
// （src/auth/session.ts，Express）有一份幾乎一樣的複本，兩邊各自
// import 不到對方（前後端是獨立的兩個 npm package，沒有共用 workspace），
// 演算法必須保持完全一致（同一個 SITE_SESSION_SECRET 簽出來的 token 兩
// 邊都要驗證得過）。**改這個檔案時，記得對照著改 src/auth/session.ts**。
//
// 只用全域的 Web Crypto API（crypto.subtle、btoa/atob）——這份會被
// middleware.ts 使用，Next.js Middleware 預設在 Edge Runtime 執行，沒有
// 完整的 node:crypto 可用，跟後端用 node:crypto 的 webcrypto 匯出、但走的
// 是同一套 Web Crypto 規格，兩邊行為一致。
//
// Token 格式：`${base64url(JSON.stringify({exp}))}.${base64url(HMAC-SHA256 簽章)}`

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

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function createSessionToken(secret: string): Promise<string> {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_TTL_MS });
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(payload));
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
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
  // TS 5.9 起 Uint8Array 對 ArrayBuffer 是 generic 的，跟 lib.dom.d.ts 的
  // BufferSource 型別（要求 ArrayBufferView<ArrayBuffer>）對不太起來，這
  // 裡強制轉型——實際資料仍然是正常的 Uint8Array，不影響執行期行為。
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes as BufferSource,
    new TextEncoder().encode(payloadB64) as BufferSource,
  );
  if (!valid) return false;

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as { exp?: unknown };
    return typeof payload.exp === 'number' && Date.now() < payload.exp;
  } catch {
    return false;
  }
}
