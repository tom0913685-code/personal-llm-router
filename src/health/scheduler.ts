import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { runDeploymentModelCheck } from './check.js';

// @article topic:health-check-design
// 排程掃描只處理 autoHealthCheckEnabled=true 且 enabled=true（deployment
// 跟所屬 credential 都要）的 deployment，不是全部 provider 定期自動檢查——
// 雲端 model 的 API 呼叫有成本，使用者自己選要排程的對象（見
// 01-config-management.md 的已定案）。
//
// 逐筆循序執行（不平行），單筆失敗用 try/catch 包住繼續下一筆，不能讓一個
// deployment 檢查失敗就中斷整個掃描。
//
// @article topic:two-tier-health-check
// 2026-09-21 起改用 runDeploymentModelCheck()（真的打一次 model），不是
// 原本只驗連線的輕量檢查——使用者明確要求排程也要抓到「model 打錯/不存
// 在」這種問題，不是等使用者自己想到要手動點。代價是排程會持續產生真的
// 呼叫 model 的 token 成本，這是使用者知情後的選擇，不是預設行為（開關
// 本身還是 per-deployment 選擇性啟用）。不傳 manual（維持預設 false），
// 排程觸發的檢查不會更新 lastManualCheckedAt。
type Db = typeof db;

// export 給測試用，實際排程進入點是下面的 startHealthCheckScheduler()。
export async function runScheduledHealthChecks(database: Db = db): Promise<void> {
  const candidates = database
    .select({ deployment: schema.modelDeployments })
    .from(schema.modelDeployments)
    .innerJoin(schema.credentials, eq(schema.modelDeployments.credentialId, schema.credentials.id))
    .where(
      and(
        eq(schema.modelDeployments.autoHealthCheckEnabled, true),
        eq(schema.modelDeployments.enabled, true),
        eq(schema.credentials.enabled, true),
      ),
    )
    .all();

  for (const { deployment } of candidates) {
    try {
      await runDeploymentModelCheck(deployment.id, database);
    } catch (err) {
      console.error(`Scheduled health check failed for deployment ${deployment.id}:`, err);
    }
  }
}

// 間隔只在啟動時讀一次環境變數，改了要重啟 process 才生效——不支援執行中
// 動態調整，個人版用不到這個彈性。
export function startHealthCheckScheduler(): void {
  const intervalMinutes = Number(process.env.HEALTH_CHECK_INTERVAL_MINUTES ?? 30);
  const intervalMs = intervalMinutes * 60_000;

  // setInterval 不會等待前一次的 async callback 完成才排下一次；候選清單
  // 多、或某個上游逾時偏長時，單輪掃描有可能跑超過 intervalMs，下一輪就會
  // 在前一輪還沒跑完時開始，對同一批 provider 重複打請求（多花成本、增加
  // 被上游 rate-limit 的風險）。用這個旗標擋掉重疊執行，前一輪還沒完成就
  // 跳過本次 tick，下一個 interval 再試。見
  // docs/code-review-findings.md 低風險 #21。
  let isRunning = false;

  setInterval(() => {
    if (isRunning) {
      console.warn('Health check scheduler tick skipped: previous run still in progress');
      return;
    }
    isRunning = true;
    runScheduledHealthChecks()
      .catch((err) => {
        console.error('Health check scheduler tick failed:', err);
      })
      .finally(() => {
        isRunning = false;
      });
  }, intervalMs);

  console.log(`Health check scheduler started (interval: ${intervalMinutes} minutes)`);
}
