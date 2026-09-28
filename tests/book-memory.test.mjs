import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryText, normalizeMemory, MEMORY_MAX_ITEMS } from '../src/lib/book-memory.ts';

test('book memory keeps only valid items, trims text and drops duplicates ids', () => {
  const items = normalizeMemory({ items: [
    { id: 'a', kind: 'definition', text: '  학습 = 행동의 지속적 변화  ', where: '1장 1절', at: 't' },
    { id: 'a', kind: 'claim', text: '중복 id' },
    { id: 'b', kind: 'nope', text: '모르는 종류' },
    { id: 'c', kind: 'keep', text: '' },
    { id: 'bad id!', kind: 'claim', text: '잘못된 id' },
    { id: 'd', kind: 'keep', text: 'x'.repeat(1000) },
  ] });
  assert.deepEqual(items.map((i) => i.id), ['a', 'd']);
  assert.equal(items[0].text, '학습 = 행동의 지속적 변화');
  assert.equal(items[1].text.length, 400);
  assert.equal(normalizeMemory(null).length, 0);
  assert.equal(normalizeMemory({ items: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, kind: 'case', text: `사례 ${i}` })) }).length, MEMORY_MAX_ITEMS);
});

test('book memory prompt block puts keep/avoid first and stays within the budget', () => {
  const items = normalizeMemory({ items: [
    { id: 'c1', kind: 'case', text: '김 교사의 첫 수업 일화', where: '2장' },
    { id: 'k1', kind: 'keep', text: '“배움은 느리다”는 의도한 표현' },
    { id: 'a1', kind: 'avoid', text: '특정 정당 언급' },
  ] });
  const block = memoryText(items);
  assert.deepEqual(block.split('\n').map((l) => l.slice(0, 8)), ['- [표현 유지', '- [쓰지 않을', '- [쓴 사례] '].map((s) => s.slice(0, 8)));
  assert.match(block, /김 교사의 첫 수업 일화 \(2장\)/);
  const many = normalizeMemory({ items: Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, kind: 'claim', text: '주장 '.repeat(20) + i })) });
  const small = memoryText(many, 500);
  assert.ok(small.length <= 560);
  assert.match(small, /그 밖 \d+개는 길이 제한으로 생략/);
  assert.equal(memoryText([]), '');
});
