import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { addError, errorKind, normalizeRoute, parseErrorDay } from '../src/lib/error-day.ts';

test('error log groups routes by shape, not by id', () => {
  assert.equal(normalizeRoute('/api/sections/cmg1abc2def3ghi4jkl/write'), '/api/sections/[id]/write');
  assert.equal(normalizeRoute('/api/projects/cmfz9x8y7w6v5u4t3s2/toc/design'), '/api/projects/[id]/toc/design');
  assert.equal(normalizeRoute('/api/health'), '/api/health');
  assert.equal(normalizeRoute('/api/chapters/abcdefghijklmnopqrst/revise'), '/api/chapters/abcdefghijklmnopqrst/revise'); // 숫자 없는 긴 낱말은 그대로
});

test('error kind keeps only name, code and status — never the raw message', () => {
  const prismaErr = Object.assign(new Error('Raw query failed … 원고 문장'), { name: 'PrismaClientKnownRequestError', code: 'P2010' });
  assert.equal(errorKind(prismaErr, 500), 'PrismaClientKnownRequestError P2010 500');
  assert.equal(errorKind(new Error('x'), 500), 'Error 500');
  assert.ok(!errorKind(prismaErr, 500).includes('원고'));
});

test('error day counts, merges and caps groups', () => {
  let d = parseErrorDay('broken');
  assert.deepEqual(d, { total: 0, groups: [] });
  const g = { route: '/api/a', kind: 'Error 500', msg: '', last: 't1' };
  d = addError(d, g);
  d = addError(d, { ...g, last: 't2' });
  assert.equal(d.total, 2);
  assert.equal(d.groups.length, 1);
  assert.equal(d.groups[0].n, 2);
  assert.equal(d.groups[0].last, 't2');
  for (let i = 0; i < 30; i++) d = addError(d, { ...g, route: `/api/r${i}` });
  assert.equal(d.total, 32);
  assert.equal(d.groups.length, 20); // 넘치는 종류는 합계에만 센다
});

test('daily check workflow never posts raw error text and needs the token', async () => {
  const wf = await readFile(new URL('../.github/workflows/daily-check.yml', import.meta.url), 'utf8');
  assert.ok(wf.includes('HEALTH_TOKEN'));
  assert.ok(wf.includes('issues: write'));
});
