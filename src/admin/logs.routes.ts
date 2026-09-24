import { Router } from 'express';
import { and, asc, desc, eq, gte, like, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

// 04-usage-cost.md 已定案：明細列表＋彙總查詢都在個人版規模下用「先撈符合
// 條件的列、再用 JS 處理排序/分頁/加總」即可，不需要為了這點資料量另外
// 寫 SQL COUNT/GROUP BY——跟 mockApi.ts 原本假資料層的作法保持一致。
function buildWhere(query: Record<string, unknown>): SQL | undefined {
  const conditions: SQL[] = [];

  const rangeHours = query.rangeHours !== undefined ? Number(query.rangeHours) : undefined;
  if (rangeHours !== undefined && !Number.isNaN(rangeHours)) {
    const cutoff = new Date(Date.now() - rangeHours * 60 * 60 * 1000).toISOString();
    conditions.push(gte(schema.requestLogs.createdAt, cutoff));
  }

  if (typeof query.publicModelName === 'string' && query.publicModelName.trim() !== '') {
    conditions.push(like(schema.requestLogs.publicModelName, `%${query.publicModelName}%`));
  }

  // 04-usage-cost.md 已定案要求的篩選欄位之一（跟 publicModelName、status
  // 並列），原本漏做。見 docs/code-review-findings.md 中風險 #12。
  if (typeof query.deploymentId === 'string' && query.deploymentId.trim() !== '') {
    conditions.push(eq(schema.requestLogs.deploymentId, query.deploymentId));
  }

  // @article topic:api-key-layer
  // 08-api-key-layer.md 提到的延伸：方便查「這把 key 花了多少」。
  if (typeof query.apiKeyId === 'string' && query.apiKeyId.trim() !== '') {
    conditions.push(eq(schema.requestLogs.apiKeyId, query.apiKeyId));
  }

  if (query.status === 'success' || query.status === 'error') {
    conditions.push(eq(schema.requestLogs.status, query.status));
  }

  return conditions.length ? and(...conditions) : undefined;
}

export const logsRouter = Router();

// 明細列表：依時間區間/public_model_name/status 篩選，分頁回傳（05-web-ui.md「請求 Log 明細頁面」）。
logsRouter.get('/', (req, res) => {
  const where = buildWhere(req.query as Record<string, unknown>);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10));

  const rows = db.select().from(schema.requestLogs).where(where).orderBy(desc(schema.requestLogs.createdAt)).all();

  const total = rows.length;
  const start = (page - 1) * pageSize;
  const items = rows.slice(start, start + pageSize);

  res.json({ items, total });
});

// 彙總查詢：花費/請求數/錯誤率/Fallback 觸發率，依 deployment 分組（05-web-ui.md「用量儀表板頁面」）。
logsRouter.get('/summary', (req, res) => {
  const where = buildWhere(req.query as Record<string, unknown>);
  // 依 created_at 升冪排序，讓下面 byDeployment 分組時「最後蓋過去」的
  // publicModelName 快照是最新的一筆——deployment 改過名字時，同一個
  // deploymentId 底下不同時間點的 log 可能存了不同的 publicModelName
  // 快照（例如原本叫 gpt-4.1，後來改名成 gpt-5.1），彙總畫面該顯示「現在
  // 叫什麼」，不是隨機哪一筆舊快照。
  const rows = db.select().from(schema.requestLogs).where(where).orderBy(asc(schema.requestLogs.createdAt)).all();

  const totalRequests = rows.length;
  const totalCost = rows.reduce((sum, r) => sum + r.cost, 0);
  const errorRequests = rows.filter((r) => r.status === 'error').length;
  // fallback 觸發率：讓使用者知道哪個 model 常常需要靠備援才能成功，是該
  // 檢查主要 deployment 的訊號（04-usage-cost.md 已定案）。
  const fallbackRequests = rows.filter((r) => r.fallbackUsed).length;

  // 分組 key 用 deploymentId，不是 publicModelName——同一個 public model
  // 底下的 primary/fallback 多筆 deployment 若共用 publicModelName，用
  // 名稱分組會把它們合併成一列，看不出哪筆 deployment 在拖累，直接違背
  // 「讓使用者知道哪個 model 常常需要靠備援」這個設計初衷（因為看不出是
  // 哪筆）。deploymentId 可能是 null（deployment 被刪除、schema 的
  // ON DELETE SET NULL），這種舊 log 用 publicModelName 當備用 key，避免
  // 全部混在同一組。見 docs/code-review-findings.md 中風險 #11。
  const byDeploymentMap = new Map<string, { deploymentId: string | null; publicModelName: string; cost: number; requests: number }>();
  for (const r of rows) {
    const key = r.deploymentId ?? `unknown:${r.publicModelName}`;
    const entry = byDeploymentMap.get(key) ?? { deploymentId: r.deploymentId, publicModelName: r.publicModelName, cost: 0, requests: 0 };
    entry.cost += r.cost;
    entry.requests += 1;
    // rows 依 created_at 升冪排序，逐筆覆蓋 publicModelName——迴圈跑完後
    // 會停在最新一筆的快照，而不是卡在第一次建立這個 key 時的舊名字。
    entry.publicModelName = r.publicModelName;
    byDeploymentMap.set(key, entry);
  }

  res.json({
    totalCost,
    totalRequests,
    errorRate: totalRequests === 0 ? 0 : errorRequests / totalRequests,
    fallbackRate: totalRequests === 0 ? 0 : fallbackRequests / totalRequests,
    byDeployment: Array.from(byDeploymentMap.values()),
  });
});

// @article topic:daily-cost-chart
// 近 N 天每日花費趨勢，給 Dashboard 畫長條圖比較日期間的用量（05-web-ui.md
// 「用量儀表板頁面」的延伸）。以 UTC 曆日分桶（createdAt 存的就是 UTC ISO
// 字串，取前 10 碼即為當天），個人版單機/單一時區使用，不特別做時區轉換。
// 範圍內沒有請求的日子也補 0，前端才能畫出連續的日期軸，一眼看出哪天沒用。
logsRouter.get('/daily', (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const rows = db.select().from(schema.requestLogs).where(gte(schema.requestLogs.createdAt, cutoff)).all();

  const byDateMap = new Map<string, { cost: number; requests: number }>();
  for (const r of rows) {
    const date = r.createdAt.slice(0, 10);
    const entry = byDateMap.get(date) ?? { cost: 0, requests: 0 };
    entry.cost += r.cost;
    entry.requests += 1;
    byDateMap.set(date, entry);
  }

  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    result.push({ date, ...(byDateMap.get(date) ?? { cost: 0, requests: 0 }) });
  }

  res.json({ days: result });
});
