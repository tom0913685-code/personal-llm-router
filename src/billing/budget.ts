import { eq } from 'drizzle-orm';
import { db as defaultDb, schema } from '../db/index.js';

type Db = typeof defaultDb;
type ApiKeyRow = typeof schema.apiKeys.$inferSelect;

// @article topic:api-key-layer
// 「這期」的起點是「往回找最近一次跨過 budget_reset_day 的那一天」，clamp
// 到當月實際天數避免 31 號在只有 30 天的月份變成無效日期（例如 2 月沒有
// 30/31 號，重置日設 31 會退到當月最後一天）。全部用 UTC 曆日計算，跟
// logs.routes.ts 的 /daily 分桶維持同一個時區基準。
function currentPeriodStart(resetDay: number, now: Date): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  const daysInThisMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const clampedThisMonth = Math.min(resetDay, daysInThisMonth);

  if (day >= clampedThisMonth) {
    return new Date(Date.UTC(year, month, clampedThisMonth));
  }

  // 這個月還沒到重置日，這期其實是從上個月的重置日開始算的。
  const daysInPrevMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const clampedPrevMonth = Math.min(resetDay, daysInPrevMonth);
  return new Date(Date.UTC(year, month - 1, clampedPrevMonth));
}

// budget_reset_day 是 null（沒設定自動重置）就永遠不算「該重置」；
// last_reset_at 是 null（從沒重置過）視為一定該重置一次，把 lastResetAt
// 正式設定成現在，作為這期的起點。
export function isBudgetResetDue(
  row: Pick<ApiKeyRow, 'budgetResetDay' | 'lastResetAt'>,
  now: Date = new Date(),
): boolean {
  if (row.budgetResetDay === null) return false;
  if (!row.lastResetAt) return true;

  const periodStart = currentPeriodStart(row.budgetResetDay, now);
  return new Date(row.lastResetAt) < periodStart;
}

// 檢查並在需要時重置這把 key 的 current_spend，回傳「有沒有真的重置」。
// 手動觸發的「立即重置」按鈕（src/admin/api-keys.routes.ts）不走這個函式
// ——那個是無條件重置，不看 isBudgetResetDue()。
export function resetBudgetIfDue(row: ApiKeyRow, database: Db = defaultDb, now: Date = new Date()): boolean {
  if (!isBudgetResetDue(row, now)) return false;

  const nowIso = now.toISOString();
  database
    .update(schema.apiKeys)
    .set({ currentSpend: 0, lastResetAt: nowIso, updatedAt: nowIso })
    .where(eq(schema.apiKeys.id, row.id))
    .run();
  return true;
}

// 請求結束後（成功或失敗）把這次的花費累加進這把 key 的 current_spend。
// 失敗請求的 cost 本來就是 0（見 04-usage-cost.md），累加 0 沒有副作用，
// 不需要另外判斷 success/error 分開處理。
export function incrementSpend(apiKeyId: string, cost: number, database: Db = defaultDb): void {
  const row = database.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, apiKeyId)).get();
  if (!row) return; // key 在請求處理過程中被刪除這種極端情況，直接放棄累加，不影響回應
  database
    .update(schema.apiKeys)
    .set({ currentSpend: row.currentSpend + cost, updatedAt: new Date().toISOString() })
    .where(eq(schema.apiKeys.id, apiKeyId))
    .run();
}
