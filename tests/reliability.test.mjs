import test from 'node:test';
import assert from 'node:assert/strict';
import { AutosaveQueue, SaveError } from '../src/lib/autosave-queue.ts';
import { shiftSection } from '../src/lib/page-shift.ts';
import { registerJobKind, sectionBusyWith } from '../src/components/editor/jobStore.ts';

/* ---------- 자동 저장: 지운 절(404) ---------- */
function setup(save) {
  let local;
  const q = new AutosaveQueue({ save, persist: async d => { local = d; },
    acknowledge: async token => { if (local?.token === token) local = undefined; }, offline: () => false });
  return { q, local: () => local };
}

test('404 from a deleted section drops the draft instead of retrying forever', async () => {
  let calls = 0;
  const { q, local } = setup(async () => { calls++; throw new SaveError('절을 찾을 수 없습니다.', 404); });
  q.mark({ content: 'lost section' });
  assert.equal(await q.flush(), true);
  assert.equal(q.draft, null);
  assert.equal(local(), undefined);
  assert.equal(q.state.kind, 'idle');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(calls, 1);
  assert.equal(await q.flush(), true); // flushAllPending가 막히지 않는다
  assert.equal(calls, 1);
  q.stopTimer();
});

test('other server errors keep the draft and report failure', async () => {
  const { q, local } = setup(async () => { throw new SaveError('서버 오류', 500); });
  q.mark({ content: 'keep me' });
  assert.equal(await q.flush(), false);
  assert.equal(q.draft.content, 'keep me');
  assert.equal(local().content, 'keep me');
  assert.equal(q.state.kind, 'error');
  q.stopTimer();
});

/* ---------- 절 하나 다시 잰 결과로 쪽 밀기 ---------- */
const sec = (startIdx, endIdx, bodyStart, extra = {}) => ({
  startIdx, endIdx,
  start: startIdx >= bodyStart ? startIdx - bodyStart + 1 : 0,
  end: endIdx >= bodyStart ? endIdx - bodyStart + 1 : 0,
  side: startIdx % 2 === 1 ? 'right' : 'left',
  pages: endIdx - startIdx + 1, startFrac: 0, chars: 1000, fig: 0, ...extra,
});
const pagesOf = (total, bodyStart) => Array.from({ length: total }, (_, k) => ({ i: k + 1, n: k + 1 >= bodyStart ? k + 2 - bodyStart : 0, side: (k + 1) % 2 ? 'right' : 'left', blank: false }));
// 앞붙이 f(3~4면) · 본문 시작 5면 · 1장 a(5~7), b(8~9) · 2장 c(11~12)
function book() {
  const B = 5;
  return {
    total: 12, bodyStart: B, fontOk: true,
    sections: { f: sec(3, 4, B), a: sec(5, 7, B), b: sec(8, 9, B), c: sec(11, 12, B) },
    chapters: { front: { start: 0 }, ch1: { start: 1 }, ch2: { start: 7 } },
    pages: pagesOf(12, B),
  };
}
const order = [{ id: 'front', sectionIds: ['f'] }, { id: 'ch1', sectionIds: ['a', 'b'] }, { id: 'ch2', sectionIds: ['c'] }];
const measured = (s, span) => ({ ...s, endIdx: s.startIdx + span - 1, pages: span, chars: 2000 });

test('numbered section growing by an even count pushes later pages and chapters', () => {
  const info = book();
  const next = shiftSection(info, 'a', measured(info.sections.a, 5), { startRight: true, chapters: order });
  assert.equal(next.sections.a.endIdx, 9);
  assert.equal(next.sections.a.end, 5);
  assert.deepEqual([next.sections.b.startIdx, next.sections.b.start, next.sections.b.side], [10, 6, 'left']);
  assert.equal(next.sections.c.start, 9);
  assert.equal(next.chapters.ch2.start, 9);
  assert.equal(next.chapters.ch1.start, 1);
  assert.equal(next.total, 14);
  assert.equal(next.pages.length, 14);
  assert.deepEqual(next.pages.map(p => p.i), Array.from({ length: 14 }, (_, k) => k + 1));
  assert.equal(next.pages[13].n, 10);
});

test('front matter change never renumbers body pages', () => {
  const info = book();
  const next = shiftSection(info, 'f', measured(info.sections.f, 4), { startRight: true, chapters: order });
  assert.equal(next.bodyStart, 7);
  assert.equal(next.sections.f.end, 0);
  assert.deepEqual([next.sections.a.startIdx, next.sections.a.start], [7, 1]);
  assert.equal(next.sections.c.start, 7);
  assert.equal(next.chapters.ch2.start, 7);
  assert.equal(next.pages[6].n, 1);
  assert.equal(next.pages[5].n, 0);
});

test('odd change before a right-hand start asks for a full measure', () => {
  const info = book();
  assert.equal(shiftSection(info, 'a', measured(info.sections.a, 4), { startRight: true, chapters: order }), null);
  // 본문 시작은 늘 오른쪽 — 앞붙이가 홀수로 바뀌면 설정과 상관없이 다시 잰다
  assert.equal(shiftSection(info, 'f', measured(info.sections.f, 3), { startRight: false, chapters: order }), null);
});

test('odd change without right-hand chapter starts shifts and flips sides', () => {
  const info = book();
  const next = shiftSection(info, 'a', measured(info.sections.a, 4), { startRight: false, chapters: order });
  assert.deepEqual([next.sections.b.startIdx, next.sections.b.start, next.sections.b.side], [9, 5, 'right']);
  assert.equal(next.sections.c.side, 'left');
  assert.equal(next.chapters.ch2.start, 8);
  // 마지막 장 마지막 절은 오른쪽 시작 설정이 켜져 있어도 뒤에 맞출 장이 없다
  const last = shiftSection(info, 'c', measured(info.sections.c, 3), { startRight: true, chapters: order });
  assert.equal(last.sections.c.end, 9);
  assert.equal(last.total, 13);
});

test('unknown section leaves info untouched', () => {
  const info = book();
  assert.equal(shiftSection(info, 'zz', info.sections.a, { startRight: true, chapters: order }), info);
});

/* ---------- 집필·교정 겹침 막기 ---------- */
test('sectionBusyWith reports other kinds only', () => {
  const busy = new Set(['s1']);
  registerJobKind('t-write', { label: '집필', busy: id => busy.has(id), any: () => busy.size > 0 });
  assert.equal(sectionBusyWith('s1'), '집필');
  assert.equal(sectionBusyWith('s1', 't-write'), null);
  assert.equal(sectionBusyWith('s2'), null);
  busy.clear();
  assert.equal(sectionBusyWith('s1'), null);
});
