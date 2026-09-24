import { createHash, timingSafeEqual } from 'node:crypto';

// 先各自算固定長度（32 bytes）的 SHA-256 雜湊，再用 timingSafeEqual() 比較
// ——直接用 `!==` 比較原始字串，JS 引擎通常在第一個不匹配的 byte 就短路，
// 比較耗時會跟「前綴匹配長度」相關，理論上可被用來逐字元暴力猜出密碼/key。
// 先雜湊成固定長度再比較，既避開 timingSafeEqual() 對輸入長度不同會直接
// throw 的限制，也讓比較耗時不再洩漏任何關於原始字串內容的資訊。
//
// 原本是 src/auth/require-api-key.ts 專用（比對 ROUTER_API_KEY），拆掉
// ROUTER_API_KEY 後搬到這裡當共用 helper，給登入密碼比對用。
export function timingSafeStringEqual(a: string, b: string): boolean {
  const aHash = createHash('sha256').update(a).digest();
  const bHash = createHash('sha256').update(b).digest();
  return timingSafeEqual(aHash, bHash);
}
