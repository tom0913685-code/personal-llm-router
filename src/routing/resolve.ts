import { eq, and, asc } from 'drizzle-orm';
import { db as defaultDb, schema } from '../db/index.js';
import { NotFoundError } from '../errors.js';

type Db = typeof defaultDb;

export interface RouteCandidate {
  deployment: typeof schema.modelDeployments.$inferSelect;
  credential: typeof schema.credentials.$inferSelect;
}

// @article topic:fallback-routing
// 03-routing-fallback.md：依 client 傳入的 model（= public_model_name）查
// model_deployments，篩選 enabled 且所屬 credential 也 enabled 的列，依
// priority 升冪排序回傳完整候選清單（不是只回第一筆）。呼叫端（Gateway）
// 負責依序嘗試，這裡只管「排出正確的候選順序」。
//
// 刻意不依 health_status 預先排除候選：health_status 是手動/排程健康檢查
// 的結果，可能是舊資料，不該拿來決定「這次請求」要不要嘗試某個
// deployment——有問題呼叫當下自然會失敗，觸發 Fallback 換下一筆。
export function resolveDeploymentCandidates(publicModelName: string, database: Db = defaultDb): RouteCandidate[] {
  const rows = database
    .select({ deployment: schema.modelDeployments, credential: schema.credentials })
    .from(schema.modelDeployments)
    .innerJoin(schema.credentials, eq(schema.modelDeployments.credentialId, schema.credentials.id))
    .where(
      and(
        eq(schema.modelDeployments.publicModelName, publicModelName),
        eq(schema.modelDeployments.enabled, true),
        eq(schema.credentials.enabled, true),
      ),
    )
    // priority 加 id 當第二排序鍵：正常情況下 (publicModelName, priority)
    // 複合唯一索引保證不會撞 priority，但排序穩定性不該完全依賴那個索引
    // 存在——索引哪天被 migration 調整、或用 CLI 直接改資料繞過 ORM 約束，
    // SQLite 對 ORDER BY 同值列沒有保證的穩定順序，會讓 fallbackUsed 判斷
    // 跟著不穩。加這個零成本，見 docs/code-review-findings.md 中風險 #17。
    .orderBy(asc(schema.modelDeployments.priority), asc(schema.modelDeployments.id))
    .all();

  if (rows.length === 0) {
    throw new NotFoundError(`model "${publicModelName}" not configured or disabled`);
  }

  return rows;
}
