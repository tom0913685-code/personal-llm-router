import type { Request, Response, NextFunction } from 'express';
import { verifySessionToken, SESSION_COOKIE_NAME } from './session.js';
import { UnauthorizedError } from '../errors.js';

function parseCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    if (part.slice(0, separatorIndex).trim() === name) {
      return decodeURIComponent(part.slice(separatorIndex + 1).trim());
    }
  }
  return undefined;
}

// 2026-09-19 取代原本的 requireApiKey：/admin/* 改用登入密碼的 session
// 驗證，不再是固定 key 比對。跟 Next.js Middleware 驗證的是同一顆 cookie、
// 同一個 SITE_SESSION_SECRET——這裡是「即使有人跳過 Next.js 直接打後端
// port」時的最後一道防線，不是多餘的重複檢查，見
// docs/requirements/06-site-auth.md「範圍」段落。
export async function requireSiteSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const secret = process.env.SITE_SESSION_SECRET;
  if (!secret) {
    throw new Error(
      'SITE_SESSION_SECRET is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  const token = parseCookie(req.header('cookie'), SESSION_COOKIE_NAME);
  const valid = await verifySessionToken(secret, token);
  if (!valid) {
    throw new UnauthorizedError('Not logged in or session expired');
  }

  next();
}
