import { isNotNull } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { resetBudgetIfDue } from './budget.js';

// @article topic:api-key-layer
// 08-api-key-layer.md 已定案：惰性重置（requireGatewayKey 每次驗證時檢查）
// 保證「拿來用的時候額度一定是最新的」，但如果一把 key 這個月完全沒被呼
// 叫過，惰性重置永遠不會被觸發，Web UI 上會一直顯示上個月的舊
// current_spend，跟「這個月還沒花錢」的事實不符——這個排程就是為了讓沒
// 被呼叫的 key 也能在畫面上顯示正確狀態，只掃 budget_reset_day 不是 null
// 的 key，逐筆循序執行，單筆失敗不中斷整批（比照
// src/health/scheduler.ts 同一套模式）。
type Db = typeof db;

// export 給測試用，實際排程進入點是下面的 startBudgetResetScheduler()。
export function runScheduledBudgetResets(database: Db = db): void {
  const rows = database.select().from(schema.apiKeys).where(isNotNull(schema.apiKeys.budgetResetDay)).all();

  for (const row of rows) {
    try {
      resetBudgetIfDue(row, database);
    } catch (err) {
      console.error(`Scheduled budget reset failed for API key ${row.id}:`, err);
    }
  }
}

// 獨立於健康檢查排程的環境變數（使用者 2026-09-19 確認要獨立設定，不跟
// HEALTH_CHECK_INTERVAL_MINUTES 共用）。同樣只在啟動時讀一次，改了要重啟
// process 才生效。
export function startBudgetResetScheduler(): void {
  const intervalMinutes = Number(process.env.BUDGET_RESET_SCAN_INTERVAL_MINUTES ?? 60);
  const intervalMs = intervalMinutes * 60_000;

  // 跟 health/scheduler.ts 一樣的防重疊 guard（docs/code-review-findings.md
  // 低風險 #21 的教訓直接套用在這個新排程上，不要重蹈覆轍）。
  let isRunning = false;

  setInterval(() => {
    if (isRunning) {
      console.warn('Budget reset scheduler tick skipped: previous run still in progress');
      return;
    }
    isRunning = true;
    try {
      runScheduledBudgetResets();
    } catch (err) {
      console.error('Budget reset scheduler tick failed:', err);
    } finally {
      isRunning = false;
    }
  }, intervalMs);

  console.log(`Budget reset scheduler started (interval: ${intervalMinutes} minutes)`);
}
