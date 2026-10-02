import test from 'node:test';
import assert from 'node:assert/strict';
import { deadlinePlan, todayKst, validDate } from '../src/lib/progress.ts';

test('deadline dates: only real YYYY-MM-DD', () => {
  assert.equal(validDate('2026-10-31'), true);
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('2026-1-5'), false);
  assert.equal(validDate(null), false);
});

test('deadline plan: days left counts today, pages per day rounds up', () => {
  // 10/2 → 10/11: 오늘 포함 10일, 남은 25쪽 → 하루 2.5쪽
  assert.deepEqual(deadlinePlan('2026-10-11', 75, 100, '2026-10-02'), { daysLeft: 10, pagesLeft: 25, perDay: 2.5 });
  // 마감 당일: 하루 남음
  assert.equal(deadlinePlan('2026-10-02', 0, 10, '2026-10-02').daysLeft, 1);
  // 지났으면 하루 분량 없음
  assert.equal(deadlinePlan('2026-10-01', 0, 10, '2026-10-02').perDay, null);
  // 다 썼으면 남은 쪽 0
  assert.deepEqual(deadlinePlan('2026-12-01', 120, 100, '2026-10-02').pagesLeft, 0);
  // 올림: 10쪽 / 3일 = 3.4
  assert.equal(deadlinePlan('2026-10-04', 0, 10, '2026-10-02').perDay, 3.4);
});

test('today is computed in Korean time', () => {
  assert.equal(todayKst(new Date('2026-10-01T16:00:00Z')), '2026-10-02');
  assert.equal(todayKst(new Date('2026-10-01T14:59:00Z')), '2026-10-01');
});
