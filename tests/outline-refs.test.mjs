import test from 'node:test';
import assert from 'node:assert/strict';
import { outlineInputHash, partsToText, textToParts, editedOutlineKey, outlineCacheKey } from '../src/lib/ai/outline-text.ts';
import { buildReferencesBlock, cleanRefText, cleanRefName, refKey, refPrefix, REF_MAX_CHARS } from '../src/lib/ai/section-refs.ts';
import { serializeEntry, snapSection, extraKeyFilters } from '../src/lib/trash.ts';

test('outline text round-trips headings, points, sketch items and part sizes', () => {
  const parts = [
    { heading: '문제 제기', points: ['왜 지금인가', '독자의 불안'], sketchItems: ['출근길 장면'], chars: 1400 },
    { heading: '해법', points: ['세 가지 습관'], sketchItems: [], chars: 2600 },
  ];
  const text = partsToText(parts);
  assert.match(text, /^## 문제 제기 \(약 1,400자\)\n- 왜 지금인가\n- 독자의 불안\n- \[스케치\] 출근길 장면/);
  assert.deepEqual(textToParts(text, 4000), parts);
});

test('parts without a size share what is left of the target', () => {
  const parts = textToParts('## 하나 (약 1000자)\n- a\n\n## 둘\n- b\n## 셋\n* c', 5000);
  assert.deepEqual(parts.map((p) => p.chars), [1000, 2000, 2000]);
  assert.deepEqual(parts[2].points, ['c']);
  // 소제목 없이 쓴 글은 소제목 없는 파트 하나
  const loose = textToParts('- 도입\n- 전개', 3000);
  assert.equal(loose.length, 1);
  assert.equal(loose[0].heading, '');
  assert.equal(loose[0].chars, 3000);
  assert.equal(textToParts(partsToText(loose), 3000)[0].heading, '');
});

test('outline text rejects empty or oversized outlines', () => {
  assert.throws(() => textToParts('   \n  ', 3000), /비어/);
  assert.throws(() => textToParts(Array.from({ length: 21 }, (_, i) => `## 파트 ${i}`).join('\n'), 3000), /20개/);
  assert.throws(() => textToParts('x'.repeat(20001), 3000), /너무 깁니다/);
});

test('outline input hash follows sketch, size, title, gist and references only', () => {
  const base = { sketch: 'notes', targetPages: 8, title: 't', gist: 'g', refIds: ['a', 'b'] };
  const h = outlineInputHash(base);
  assert.equal(outlineInputHash({ ...base, refIds: ['b', 'a'], sketch: ' notes ' }), h);
  for (const changed of [{ sketch: 'new' }, { targetPages: 9 }, { title: 'x' }, { gist: 'y' }, { refIds: ['a'] }]) {
    assert.notEqual(outlineInputHash({ ...base, ...changed }), h);
  }
  assert.equal(editedOutlineKey('s1'), 'outline-edit:s1');
  assert.equal(outlineCacheKey('s1'), 'ai:outline-cache:s1');
  assert.ok(!editedOutlineKey('s1').startsWith('ai:outline-cache:'), 'daily cache purge must not remove author outlines');
});

test('references block shares the budget and gives unused room to longer sources', () => {
  const block = buildReferencesBlock([{ name: '짧은 자료', text: 'a'.repeat(100) }, { name: '긴 자료', text: 'b'.repeat(5000) }], 1000);
  assert.match(block, /### 자료 1: 짧은 자료\na{100}\n/);
  assert.match(block, /### 자료 2: 긴 자료 \(앞 900자만 발췌\)\nb{900}\n…\(이하 생략\)$/);
  assert.equal(buildReferencesBlock([]), '');
  assert.equal(buildReferencesBlock([{ name: 'x', text: '   ' }]), '');
  const many = buildReferencesBlock(Array.from({ length: 5 }, (_, i) => ({ name: `자료${i}`, text: 'c'.repeat(10000) })), 12000);
  assert.equal((many.match(/c/g) ?? []).length, 12000);
});

test('reference text and names are cleaned and capped', () => {
  assert.deepEqual(cleanRefText('﻿첫 줄  \r\n\r\n\r\n\r\n둘째\t줄'), { text: '첫 줄\n\n둘째 줄', truncated: false });
  const long = cleanRefText('가'.repeat(REF_MAX_CHARS + 10));
  assert.equal(long.text.length, REF_MAX_CHARS);
  assert.equal(long.truncated, true);
  assert.equal(cleanRefName('  보고서⟦주⟧\n2025 '), '보고서 주 2025');
  assert.equal(refKey('s1', 'r1'), 'ref:s1:r1');
  assert.ok(refKey('s1', 'r1').startsWith(refPrefix('s1')));
  assert.ok(!refKey('s10', 'r1').startsWith(refPrefix('s1')));
});

test('trash keeps section references and edited outlines, dropping them only when too large', () => {
  const sec = snapSection({ id: 's1', title: '절', gist: '', hook: '', targetPages: 3, status: 'editing', sketch: '', content: '본문', charCount: 2, summary: null, summaryHash: null, updatedAt: new Date(), versions: [] });
  const e = {
    meta: { id: 's1', kind: 'section', title: '절', label: '1.1', deletedAt: '2026-09-27T00:00:00Z', charCount: 2 },
    projectId: 'p1', chapterId: 'c1', index: 0, section: sec,
    extras: [{ key: 'ref:s1:r1', value: JSON.stringify({ id: 'r1', text: 'x'.repeat(3000) }) }, { key: 'outline-edit:s1', value: '{}' }],
  };
  assert.equal(JSON.parse(serializeEntry(e)).extras.length, 2);
  const lean = JSON.parse(serializeEntry(e, 1500));
  assert.deepEqual(lean.extras, []);
  assert.equal(lean.meta.extrasDropped, true);
  assert.equal(lean.section.content, '본문');
  const filters = extraKeyFilters(['s1', 's2']);
  assert.deepEqual(filters.at(-1), { key: { in: ['outline-edit:s1', 'outline-edit:s2'] } });
  assert.deepEqual(filters[0], { key: { startsWith: 'ref:s1:' } });
});
