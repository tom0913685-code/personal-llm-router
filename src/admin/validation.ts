import { ValidationError } from '../errors.js';

export function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} is required`);
  }
  return value;
}

// 只接受真正的 boolean，不用 Boolean() 硬轉型——`Boolean("false")` 求值是
// `true`，字串 "false" 會被誤判成啟用/開啟。見
// docs/code-review-findings.md 高風險 #7。
export function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean`);
  }
  return value;
}

export function assertNumberOrDefault(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative number`);
  }
  return value;
}

// priority 是排序用的整數（見 model_deployments schema 的 integer 欄位），
// 浮點數在 SQLite 動態型別下仍會被接受寫入，但已偏離 schema 宣告的整數
// 語意。見 docs/code-review-findings.md（設定管理 review 原始發現 #4）。
export function assertIntegerOrDefault(value: unknown, field: string, fallback: number): number {
  const num = assertNumberOrDefault(value, field, fallback);
  if (!Number.isInteger(num)) {
    throw new ValidationError(`${field} must be an integer`);
  }
  return num;
}

// 08-api-key-layer.md：budget_reset_day 是每月第幾天重置，1-31。
export function assertBudgetResetDay(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 31) {
    throw new ValidationError('budgetResetDay must be an integer between 1 and 31');
  }
  return value;
}

// 08-api-key-layer.md：allowed_models 是字串陣列（public_model_name 清單）
// 或 null（不限制）。
export function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new ValidationError(`${field} must be an array of strings`);
  }
  return value;
}

// 08-api-key-layer.md：expires_at 存 ISO 字串，直接給 `new Date(...)` 解析
// ——不驗證格式的話，格式錯誤的字串會讓 `new Date(garbage).getTime()` 算
// 出 NaN，`NaN < Date.now()` 恆為 false，這把 key 會變成永遠不會過期，卻
// 又在畫面上顯示著一個看似正常的到期日，是個難以察覺的靜默失效。
export function assertIsoDateString(value: unknown, field: string): string {
  const str = assertNonEmptyString(value, field);
  if (Number.isNaN(Date.parse(str))) {
    throw new ValidationError(`${field} must be a valid ISO date string`);
  }
  return str;
}
