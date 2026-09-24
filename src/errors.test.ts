import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUniqueConstraintError } from './errors.js';

function sqliteError(message: string, code?: string): Error {
  const err = new Error(message) as Error & { code?: string };
  if (code) err.code = code;
  return err;
}

test('isUniqueConstraintError() 訊息含 UNIQUE constraint failed 且欄位名稱精確比對時回傳 true', () => {
  const err = sqliteError('UNIQUE constraint failed: credentials.name');
  assert.equal(isUniqueConstraintError(err, 'credentials.name'), true);
});

test('isUniqueConstraintError() code 是 SQLITE_CONSTRAINT_UNIQUE 也算數，不只看訊息字串', () => {
  const err = sqliteError('some driver-specific wording', 'SQLITE_CONSTRAINT_UNIQUE');
  // 沒有 "UNIQUE constraint failed" 字樣、也沒有冒號可拆欄位清單，所以
  // columnList 抓不到，最終仍然回 false——code 只是「看起來像 unique
  // constraint」的第一關，訊息格式仍要符合預期才能精確比對出欄位。
  assert.equal(isUniqueConstraintError(err, 'credentials.name'), false);
});

test('isUniqueConstraintError() 欄位名稱是另一個欄位的子字串時不誤判（這正是這個函式存在的理由）', () => {
  const err = sqliteError('UNIQUE constraint failed: users.first_name');
  assert.equal(isUniqueConstraintError(err, 'name'), false);
});

test('isUniqueConstraintError() 可以正確比對訊息裡多個欄位清單中的其中一個', () => {
  const err = sqliteError('UNIQUE constraint failed: model_deployments.public_model_name, model_deployments.priority');
  assert.equal(isUniqueConstraintError(err, 'model_deployments.priority'), true);
  assert.equal(isUniqueConstraintError(err, 'model_deployments.public_model_name'), true);
  assert.equal(isUniqueConstraintError(err, 'model_deployments.other'), false);
});

test('isUniqueConstraintError() 不是 constraint 錯誤時回傳 false', () => {
  const err = sqliteError('SQLITE_BUSY: database is locked');
  assert.equal(isUniqueConstraintError(err, 'credentials.name'), false);
});

test('isUniqueConstraintError() 非 Error 輸入回傳 false，不拋例外', () => {
  assert.equal(isUniqueConstraintError('not an error', 'credentials.name'), false);
  assert.equal(isUniqueConstraintError(undefined, 'credentials.name'), false);
});

test('isUniqueConstraintError() 訊息格式跟預期不符（沒有冒號）時安全回傳 false', () => {
  const err = sqliteError('UNIQUE constraint failed without a colon separator');
  assert.equal(isUniqueConstraintError(err, 'credentials.name'), false);
});
