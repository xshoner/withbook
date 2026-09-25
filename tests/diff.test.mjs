import test from 'node:test';
import assert from 'node:assert/strict';
import { diffWords, diffDocParagraphs, tokenize } from '../src/lib/doc/diff.ts';

const side = (parts, keep) => parts.filter((p) => p.type === 'same' || p.type === keep).map((p) => p.text).join('');

test('tokenize keeps spaces and punctuation so joining reproduces text', () => {
  const s = '그는 “가자.”라고 말했다.  3.5%가 늘었다!';
  assert.equal(tokenize(s).join(''), s);
  assert.deepEqual(tokenize('나는, 간다'), ['나는', ',', ' ', '간다']);
});

test('diffWords marks only the changed 어절 and reproduces both sides', () => {
  const a = '오늘은 날씨가 매우 좋았다.';
  const b = '오늘은 날씨가 조금 흐렸다.';
  const d = diffWords(a, b);
  assert.equal(side(d, 'del'), a);
  assert.equal(side(d, 'add'), b);
  assert.deepEqual(d, [
    { type: 'same', text: '오늘은 날씨가 ' },
    { type: 'del', text: '매우 좋았다' },
    { type: 'add', text: '조금 흐렸다' },
    { type: 'same', text: '.' },
  ]);
});

test('diffWords: identical, empty, insertion', () => {
  assert.deepEqual(diffWords('같다', '같다'), [{ type: 'same', text: '같다' }]);
  assert.deepEqual(diffWords('', ''), []);
  assert.deepEqual(diffWords('', '새 글'), [{ type: 'add', text: '새 글' }]);
  const d = diffWords('나는 간다.', '나는 빨리 간다.');
  assert.deepEqual(d.filter((p) => p.type !== 'same'), [{ type: 'add', text: '빨리 ' }]);
  assert.equal(side(d, 'add'), '나는 빨리 간다.');
});

test('diffWords merges adjacent runs (no two neighbours of the same type)', () => {
  const d = diffWords('가 나 다 라 마 바', '가 X Y 라 Z 바');
  for (let i = 1; i < d.length; i++) assert.ok(!(d[i].type === d[i - 1].type), JSON.stringify(d));
  assert.equal(side(d, 'del'), '가 나 다 라 마 바');
  assert.equal(side(d, 'add'), '가 X Y 라 Z 바');
});

test('diffWords falls back to whole del+add past the token cap', () => {
  const a = Array.from({ length: 2000 }, (_, i) => `a${i}`).join(' ');
  const b = Array.from({ length: 2000 }, (_, i) => `b${i}`).join(' ');
  const d = diffWords(a, b);
  assert.deepEqual(d.map((p) => p.type), ['del', 'add']);
  assert.equal(d[0].text, a);
  assert.equal(d[1].text, b);
});

test('diffDocParagraphs pairs similar edits as change rows', () => {
  const a = ['## 제목', '첫 문단은 그대로다.', '둘째 문단은 여기서 조금 고친다.', '지워질 문단이다.'];
  const b = ['## 제목', '첫 문단은 그대로다.', '둘째 문단은 여기서 많이 고친다.', '완전히 새로운 내용 추가'];
  const rows = diffDocParagraphs(a, b);
  assert.deepEqual(rows.map((r) => r.type), ['same', 'same', 'change', 'del', 'add']);
  const ch = rows[2];
  assert.equal(ch.before, a[2]);
  assert.equal(ch.after, b[2]);
  assert.deepEqual(ch.words.filter((w) => w.type !== 'same').map((w) => w.text), ['조금', '많이']);
});

test('diffDocParagraphs keeps unrelated del/add apart and handles empty sides', () => {
  const rows = diffDocParagraphs(['사과가 맛있다.'], ['전혀 다른 이야기를 한다.']);
  assert.deepEqual(rows.map((r) => r.type), ['del', 'add']);
  assert.deepEqual(diffDocParagraphs([], ['새 문단']), [{ type: 'add', text: '새 문단' }]);
  assert.deepEqual(diffDocParagraphs(['옛 문단'], []), [{ type: 'del', text: '옛 문단' }]);
});

test('diffDocParagraphs emits inserted paragraphs before a paired change in order', () => {
  const a = ['그는 천천히 걸어서 집으로 갔다.'];
  const b = ['새로 넣은 문단입니다.', '그는 빠르게 걸어서 집으로 갔다.'];
  const rows = diffDocParagraphs(a, b);
  assert.deepEqual(rows.map((r) => r.type), ['add', 'change']);
});
