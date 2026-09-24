// 04-usage-cost.md 已定案：provider_error 寫入前先做基本遮罩（欄位名稱層級，
// 比照另一套正式版 Router 的 audit-log.service.ts 的 scrub() 做法）。
// 已知限制：只防得住「欄位名稱看得出是敏感資料」的情況，防不住錯誤訊息裡
// 用自然語言夾帶敏感內容——這點文件裡已經寫明，不是這裡漏做。
const SENSITIVE_KEY_PATTERN = /password|api[_-]?key|token|secret|authorization|credential/i;
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;

export function scrubSensitive(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  // @article topic:error-message-scrub-bypass
  // 超過深度限制時 fail-closed（整個換成 REDACTED），不是原樣放行——原本
  // 超過 MAX_DEPTH 直接回傳未遮罩的原始值，等於「深度夠深就不遮罩」，這條
  // 路徑目前雖然是 dormant（唯一呼叫點目前只有 1 層深），但一旦上游巢狀
  // JSON 錯誤內容被完整保留下來喂給這個函式（見 #3 的修法），這裡就會變成
  // 真正的洩漏路徑。見 docs/code-review-findings.md 低風險 #20。
  if (depth > MAX_DEPTH) {
    return REDACTED;
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubSensitive(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : scrubSensitive(val, depth + 1);
  }
  return result;
}
