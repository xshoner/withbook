import test from 'node:test';
import assert from 'node:assert/strict';
import { versionsToDrop } from '../src/lib/version-policy.ts';

const now = Date.parse('2026-09-25T12:00:00Z');
const at = (h) => new Date(now - h * 3600_000);

test('autosave keeps 10 recent, then one per day for 14 days', () => {
  // 최신순: 30분 간격 12개(오늘) + 하루 전 3개 + 20일 전 1개
  const rows = [
    ...Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, reason: 'autosave', createdAt: at(i * 0.5) })),
    ...[24, 25, 26].map((h, i) => ({ id: `d${i}`, reason: 'autosave', createdAt: at(h) })),
    { id: 'old', reason: 'autosave', createdAt: at(24 * 20) },
  ];
  const drop = versionsToDrop(rows, now);
  // 11번째(a10)는 오늘치 하루 1개로 남고 a11은 지운다, 하루 전은 첫 것(d0)만, 20일 전은 지운다
  assert.deepEqual(drop.sort(), ['a11', 'd1', 'd2', 'old'].sort());
});

test('manual 30, ai_output 3, others 30', () => {
  const mk = (reason, n) => Array.from({ length: n }, (_, i) => ({ id: `${reason}${i}`, reason, createdAt: at(i) }));
  const drop = versionsToDrop([...mk('manual', 32), ...mk('ai_output', 5), ...mk('ai_write', 20), ...mk('proofread', 15)], now);
  assert.equal(drop.filter((d) => d.startsWith('manual')).length, 2);
  assert.deepEqual(drop.filter((d) => d.startsWith('ai_output')), ['ai_output3', 'ai_output4']);
  assert.equal(drop.filter((d) => d.startsWith('ai_write') || d.startsWith('proofread')).length, 5);
});
