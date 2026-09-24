import { NextResponse, type NextRequest } from 'next/server';
import { verifySessionToken, SESSION_COOKIE_NAME } from './lib/session';

// 06-site-auth.md 已定案：登入密碼的 session cookie 擋所有頁面路由，沒有
// 有效 session 就導去 /login。/admin/* 刻意不在這裡擋——那是給前端 fetch
// 呼叫用的 API 路徑，被導向 /login（HTML 頁面）對呼叫端沒有意義，改成讓
// 401 直接穿透回去，由呼叫端（lib/api.ts）自己判斷要不要導頁。/admin/*
// 本身有 Express 那邊的 requireSiteSession 獨立驗證同一顆 cookie，不靠這
// 個 middleware 把關。
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === '/login' || pathname.startsWith('/api/') || pathname.startsWith('/admin/')) {
    return NextResponse.next();
  }

  const secret = process.env.SITE_SESSION_SECRET;
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const valid = secret ? await verifySessionToken(secret, token) : false;

  if (!valid) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
