import { NextResponse, type NextRequest } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_TTL_MS } from '../../../lib/session';

// Route Handler 預設在 Node.js runtime（不像 middleware.ts 預設 Edge
// Runtime），可以直接用 node:crypto 的傳統 API，不用像 lib/session.ts 那
// 樣特別遷就 Edge Runtime 能用的子集。密碼比對用跟後端
// src/security/timing-safe.ts 一樣的手法：先雜湊成固定長度再
// timingSafeEqual()，避免 `!==` 直接比較字串在第一個不匹配 byte 就短路
// 洩漏比較耗時的問題。這個函式很小、只有這裡用到，沒有另外抽成共用模組。
function timingSafeStringEqual(a: string, b: string): boolean {
  const aHash = createHash('sha256').update(a).digest();
  const bHash = createHash('sha256').update(b).digest();
  return timingSafeEqual(aHash, bHash);
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const password = typeof body?.password === 'string' ? body.password : '';

  const expected = process.env.SITE_PASSWORD;
  if (!expected) {
    return NextResponse.json({ error: 'SITE_PASSWORD 未設定' }, { status: 500 });
  }
  if (!timingSafeStringEqual(password, expected)) {
    return NextResponse.json({ error: '密碼錯誤' }, { status: 401 });
  }

  const secret = process.env.SITE_SESSION_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'SITE_SESSION_SECRET 未設定' }, { status: 500 });
  }

  const token = await createSessionToken(secret);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    // 本機用 HTTP 開發時 Secure cookie 瀏覽器不會送，只在生產環境（預期
    // 走 HTTPS）才加上，見 06-site-auth.md「Cookie 屬性」已定案。
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
  return res;
}
