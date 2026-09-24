export class ValidationError extends Error {
  readonly status = 400;
  readonly type = 'invalid_request_error';
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends Error {
  readonly status = 401;
  readonly type = 'authentication_error';
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class NotFoundError extends Error {
  readonly status = 404;
  readonly type = 'not_found_error';
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  readonly status = 409;
  readonly type = 'conflict_error';
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

// @article topic:api-key-layer
// 08-api-key-layer.md 已定案：API key 額度用完時用 429（不是 403）——
// 沿用 OpenAI 對「額度用完」的慣例（type: insufficient_quota），跟模型
// 權限不足（ForbiddenError，403）是不同性質的拒絕：額度用完換個週期或
// 加額度就能再用，模型權限是這把 key 天生就不能打這個 model。
export class BudgetExceededError extends Error {
  readonly status = 429;
  readonly type = 'insufficient_quota';
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

// @article topic:api-key-layer
// API key 通過驗證（是真的存在、啟用、沒過期、額度沒超），但這把 key 的
// allowed_models 白名單不包含這次要打的 model——「認得這把 key，但它天生
// 沒有權限做這件事」，用 403 而不是 401。
export class ForbiddenError extends Error {
  readonly status = 403;
  readonly type = 'permission_error';
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

// Adapter 呼叫上游 provider 失敗（網路錯誤、provider 回非 2xx）時用這個，
// 對應 02-gateway.md「Adapter 拋出的 Error 需轉換成合理的 HTTP 狀態碼」。
export class UpstreamError extends Error {
  readonly status = 502;
  readonly type = 'upstream_error';
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

// 判斷某個 DB 寫入錯誤是不是「這個特定欄位的唯一索引衝突」。
// 原本只用 .includes('UNIQUE constraint failed') + .includes(column) 兩個
// 字串子字串比對，脆弱在兩處：(1) 完全依賴 better-sqlite3 的錯誤訊息格式
// 不變，訊息格式是實作細節不是穩定合約；(2) .includes(column) 是子字串
// 比對，欄位名稱若互為子字串（例如 name/first_name）會誤判。見
// docs/code-review-findings.md 中風險 #16。
export function isUniqueConstraintError(err: unknown, column: string): boolean {
  if (!(err instanceof Error)) return false;

  const code = (err as { code?: string }).code;
  const looksLikeUniqueConstraint = code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message.includes('UNIQUE constraint failed');
  if (!looksLikeUniqueConstraint) return false;

  // 訊息格式固定是 "UNIQUE constraint failed: table.col1, table.col2"，
  // 拆出冒號後面的欄位清單逐一精確比對，取代子字串比對。訊息格式跟預期
  // 不符時（未來驅動版本可能改格式）安全地回傳 false，不誤判成別的
  // constraint。
  const columnList = err.message.split(':')[1];
  if (!columnList) return false;
  const columns = columnList.split(',').map((c) => c.trim());
  return columns.includes(column);
}

// @article topic:error-message-scrub-bypass
// Adapter 層拋出的上游錯誤：`.message` 刻意只放安全、不含上游回應內容的
// 泛用文字（例如「Provider error: 401」），完整的、可能夾帶敏感內容的錯誤
// 細節放在 `.providerDetail`（結構化 JSON，未遮罩），由呼叫端在存 log 前
// 自行過 scrubSensitive() 再使用。
//
// 這是為了修掉「Error.message 被拿去攤平成字串直接存 DB／回給 client，
// scrubSensitive() 只比對物件 key 名稱、對純字串完全沒作用」這個問題——
// 見 docs/code-review-findings.md 高風險 #3。
export class UpstreamProviderError extends Error {
  constructor(
    message: string,
    readonly providerDetail: unknown = undefined,
  ) {
    super(message);
    this.name = 'UpstreamProviderError';
  }
}
