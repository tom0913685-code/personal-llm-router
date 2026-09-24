import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubSensitive } from './scrub.js';

test('scrubSensitive() 遮罩頂層敏感欄位', () => {
  const result = scrubSensitive({ message: 'ok', api_key: 'sk-secret', password: 'hunter2' }) as any;
  assert.equal(result.message, 'ok');
  assert.equal(result.api_key, '[REDACTED]');
  assert.equal(result.password, '[REDACTED]');
});

test('scrubSensitive() 遞迴處理巢狀物件', () => {
  const result = scrubSensitive({ error: { details: { api_key: 'sk-secret', message: 'invalid' } } }) as any;
  assert.equal(result.error.details.api_key, '[REDACTED]');
  assert.equal(result.error.details.message, 'invalid');
});

test('scrubSensitive() 遞迴處理陣列裡的物件', () => {
  const result = scrubSensitive({ errors: [{ token: 'abc' }, { message: 'ok' }] }) as any;
  assert.equal(result.errors[0].token, '[REDACTED]');
  assert.equal(result.errors[1].message, 'ok');
});

test('scrubSensitive() 非物件值原樣回傳', () => {
  assert.equal(scrubSensitive('plain string'), 'plain string');
  assert.equal(scrubSensitive(42), 42);
  assert.equal(scrubSensitive(null), null);
  assert.equal(scrubSensitive(undefined), undefined);
});

test('scrubSensitive() 超過深度限制時 fail-closed（整包換成 [REDACTED]），不是原樣放行', () => {
  // 建一個超過 MAX_DEPTH（6）層的巢狀物件。
  let deep: any = { secretAtBottom: 'sk-should-not-leak' };
  for (let i = 0; i < 10; i++) {
    deep = { nested: deep };
  }
  const result = scrubSensitive(deep) as any;

  // 沿著 nested 往下走到超過深度限制的那一層，應該直接是 '[REDACTED]'
  // 字串，而不是繼續往下看得到原始的 secretAtBottom。
  let cursor = result;
  let depth = 0;
  while (cursor && typeof cursor === 'object' && 'nested' in cursor && depth < 20) {
    cursor = cursor.nested;
    depth++;
  }
  assert.equal(cursor, '[REDACTED]', '超過深度限制應該整包變成 [REDACTED]，不能原樣洩漏底層內容');
});
