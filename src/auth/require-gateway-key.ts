import type { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { db as defaultDb, schema } from '../db/index.js';
import { hashApiKey } from '../security/api-key.js';
import { resetBudgetIfDue } from '../billing/budget.js';
import { runExclusive } from '../billing/key-lock.js';
import { UnauthorizedError, BudgetExceededError, ForbiddenError } from '../errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: typeof schema.apiKeys.$inferSelect;
    }
  }
}

type Db = typeof defaultDb;

// @article topic:api-key-layer
// 2026-09-19（docs/auth-migration-plan.md Phase 2）：取代原本的
// requireApiKey，/v1/* 改用這批多組、有額度上限/模型權限的 Gateway API
// Key，不再是單一固定的 ROUTER_API_KEY。依序檢查（見
// docs/requirements/08-api-key-layer.md「驗證與額度檢查」）：格式 → 查表
// → 啟用 → 到期 → 預算（含惰性重置）→ 模型權限。任何一關沒過都不寫入
// request_logs（跟原本 requireApiKey 的行為一致，這個階段還沒解析出
// deployment，沒有 snapshot 資料可以附著）。
export function requireGatewayKey(database: Db = defaultDb) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization');
    const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!provided) {
      throw new UnauthorizedError('Invalid or missing API key');
    }

    const hash = hashApiKey(provided);
    const row = database.select().from(schema.apiKeys).where(eq(schema.apiKeys.keyHash, hash)).get();
    if (!row) {
      throw new UnauthorizedError('Invalid or missing API key');
    }

    if (!row.enabled) {
      throw new UnauthorizedError('This API key has been disabled');
    }

    if (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now()) {
      throw new UnauthorizedError('This API key has expired');
    }

    // @article topic:api-key-layer
    // 額度檢查（含惰性重置）到這次請求真正處理完（chat.routes.ts 呼叫
    // incrementSpend()）之間隔著一次 await 上游的空窗期。用 runExclusive()
    // 把「檢查額度」到「這個請求的 response 真正送出」整段依 key 序列化：
    // 同一把 key 的下一個請求要等前一個完全結束才會開始自己的額度檢查，
    // 保證看到的 current_spend 一定是最新的，見 src/billing/key-lock.ts
    // 的說明。format/lookup/enabled/expiry 這些跟 current_spend 無關的
    // 檢查不受影響，鎖之前就做完了。
    runExclusive(row.id, async (): Promise<void> => {
      let freshRow = database.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, row.id)).get();
      if (!freshRow) {
        throw new UnauthorizedError('Invalid or missing API key');
      }

      if (resetBudgetIfDue(freshRow, database)) {
        freshRow = database.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, row.id)).get()!;
      }

      if (freshRow.budgetLimit !== null && freshRow.currentSpend >= freshRow.budgetLimit) {
        throw new BudgetExceededError('This API key has exceeded its budget limit');
      }

      // 模型權限要在 body 解析出 model 之後才能檢查——express.json() 已經
      // 在這個 middleware 前面跑過，req.body 這裡已經可用。body.model 缺
      // 失這種情況留給下游 chat.routes.ts 的「model is required」驗證處
      // 理，這裡不重複判斷。
      if (freshRow.allowedModels !== null) {
        const requestedModel = typeof req.body?.model === 'string' ? req.body.model : undefined;
        if (requestedModel && !freshRow.allowedModels.includes(requestedModel)) {
          throw new ForbiddenError(`This API key is not permitted to use model "${requestedModel}"`);
        }
      }

      req.apiKey = freshRow;

      // 鎖要一直握到這個請求真正結束（response 送出或連線中斷）才能放，
      // 不是檢查通過就放——否則下一個排隊的請求會在 incrementSpend() 執
      // 行前就拿到鎖，又回到原本的競態。
      return new Promise<void>((resolve) => {
        res.once('finish', resolve);
        res.once('close', resolve);
        next();
      });
    }).catch(next);
  };
}
