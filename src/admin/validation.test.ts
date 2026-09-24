import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValidationError } from '../errors.js';
import {
  assertNonEmptyString,
  assertBoolean,
  assertNumberOrDefault,
  assertIntegerOrDefault,
  assertBudgetResetDay,
  assertStringArray,
  assertIsoDateString,
} from './validation.js';

test('assertNonEmptyString() 接受非空字串，拒絕非字串/空字串/純空白', () => {
  assert.equal(assertNonEmptyString('hello', 'field'), 'hello');
  assert.throws(() => assertNonEmptyString('', 'field'), ValidationError);
  assert.throws(() => assertNonEmptyString('   ', 'field'), ValidationError);
  assert.throws(() => assertNonEmptyString(123, 'field'), ValidationError);
  assert.throws(() => assertNonEmptyString(undefined, 'field'), ValidationError);
});

test('assertBoolean() 只接受真正的 boolean，拒絕看起來像 boolean 的字串（Boolean("false") 是 true 的那個坑）', () => {
  assert.equal(assertBoolean(true, 'field'), true);
  assert.equal(assertBoolean(false, 'field'), false);
  assert.throws(() => assertBoolean('false', 'field'), ValidationError);
  assert.throws(() => assertBoolean('true', 'field'), ValidationError);
  assert.throws(() => assertBoolean(1, 'field'), ValidationError);
  assert.throws(() => assertBoolean(0, 'field'), ValidationError);
});

test('assertNumberOrDefault() undefined 回傳 fallback，拒絕負數/NaN/Infinity', () => {
  assert.equal(assertNumberOrDefault(undefined, 'field', 42), 42);
  assert.equal(assertNumberOrDefault(10, 'field', 0), 10);
  assert.equal(assertNumberOrDefault(0, 'field', 99), 0);
  assert.throws(() => assertNumberOrDefault(-1, 'field', 0), ValidationError);
  assert.throws(() => assertNumberOrDefault(NaN, 'field', 0), ValidationError);
  assert.throws(() => assertNumberOrDefault(Infinity, 'field', 0), ValidationError);
  assert.throws(() => assertNumberOrDefault('10', 'field', 0), ValidationError);
});

test('assertIntegerOrDefault() 拒絕浮點數，接受整數與 fallback', () => {
  assert.equal(assertIntegerOrDefault(undefined, 'field', 5), 5);
  assert.equal(assertIntegerOrDefault(3, 'field', 0), 3);
  assert.throws(() => assertIntegerOrDefault(1.5, 'field', 0), ValidationError);
});

test('assertBudgetResetDay() 只接受 1-31 之間的整數', () => {
  assert.equal(assertBudgetResetDay(1), 1);
  assert.equal(assertBudgetResetDay(31), 31);
  assert.throws(() => assertBudgetResetDay(0), ValidationError);
  assert.throws(() => assertBudgetResetDay(32), ValidationError);
  assert.throws(() => assertBudgetResetDay(15.5), ValidationError);
  assert.throws(() => assertBudgetResetDay('15'), ValidationError);
});

test('assertStringArray() 接受字串陣列（含空陣列），拒絕非陣列或含非字串元素', () => {
  assert.deepEqual(assertStringArray(['a', 'b'], 'field'), ['a', 'b']);
  assert.deepEqual(assertStringArray([], 'field'), []);
  assert.throws(() => assertStringArray('not-an-array', 'field'), ValidationError);
  assert.throws(() => assertStringArray(['a', 1], 'field'), ValidationError);
});

test('assertIsoDateString() 接受合法日期字串，拒絕無法解析的格式（避免靜默產生 NaN 而永不過期）', () => {
  assert.equal(assertIsoDateString('2026-12-31T00:00:00.000Z', 'field'), '2026-12-31T00:00:00.000Z');
  assert.throws(() => assertIsoDateString('not-a-date', 'field'), ValidationError);
  assert.throws(() => assertIsoDateString('', 'field'), ValidationError);
});
