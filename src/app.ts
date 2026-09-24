import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { adminRouter } from './admin/router.js';
import { chatRouter } from './gateway/chat.routes.js';
import { requireGatewayKey } from './auth/require-gateway-key.js';
import { requireSiteSession } from './auth/require-site-session.js';

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // 2026-09-19 修訂（docs/auth-migration-plan.md）：ROUTER_API_KEY 整個拿
  // 掉了。/admin/* 換成登入密碼的 session 驗證（Phase 1，06-site-auth.md）；
  // /v1/* 換成這裡的 requireGatewayKey（Phase 2，08-api-key-layer.md）——
  // 多組、各自有額度上限/模型權限/到期時間的 API Key，不再是單一固定 key。
  app.use('/admin', requireSiteSession, adminRouter);
  app.use('/v1', requireGatewayKey(), chatRouter);

  // 集中錯誤處理：自訂 Error 類別（見 src/errors.ts）都帶 status/type，
  // 其餘未預期例外一律 500，避免把內部錯誤細節洩漏給 client。
  //
  // @article topic:error-message-scrub-bypass
  // code review 2026-09-23 抓到的問題：原本不管有沒有 .status 都直接把
  // err.message 回給 client，等於這段註解說的「避免洩漏」完全沒有真的
  // 生效——只有我們自己定義的 Error 類別（有明確的 .status，訊息是刻意
  // 寫的安全文字）才信任它的 .message；沒有 .status、走到預設 500 的，
  // 代表這是一個沒被接住的未預期例外，一律回泛用文字，真正的內容只留在
  // 伺服器端的 console.error，不外流給任何呼叫端（包含拿著 Gateway API
  // Key 的外部呼叫者）。
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const hasKnownStatus = err instanceof Error && 'status' in err && typeof (err as { status: unknown }).status === 'number';
    const status = hasKnownStatus ? (err as { status: number }).status : 500;
    const type = err instanceof Error && 'type' in err && typeof (err as { type: unknown }).type === 'string'
      ? (err as { type: string }).type
      : 'internal_error';
    const message = hasKnownStatus && err instanceof Error ? err.message : 'Internal server error';
    if (status === 500) {
      console.error(err);
    }
    res.status(status).json({ error: { message, type } });
  });

  return app;
}
