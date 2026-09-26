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

// Independent full-matrix reference: catches traceback/tie-breaking regressions.
function referenceRows(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { rows.push({ type: 'same', text: a[i++] }); j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) rows.push({ type: 'del', text: a[i++] });
    else rows.push({ type: 'add', text: b[j++] });
  }
  while (i < a.length) rows.push({ type: 'del', text: a[i++] });
  while (j < b.length) rows.push({ type: 'add', text: b[j++] });
  return rows;
}

test('compact traceback preserves LCS ties across repeated paragraphs and bit boundaries', () => {
  let seed = 12345;
  const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  // Distinct tokens never pair as changed paragraphs, so raw LCS rows are observable.
  const values = ['가', '나', '다', '라'];
  for (let t = 0; t < 1000; t++) {
    const arr = () => Array.from({ length: Math.floor(rand() * 25) }, () => values[Math.floor(rand() * values.length)]);
    const a = arr(), b = arr();
    assert.deepEqual(diffDocParagraphs(a, b), referenceRows(a, b));
    const words = diffWords(a.join(' '), b.join(' '));
    assert.equal(side(words, 'del'), a.join(' '));
    assert.equal(side(words, 'add'), b.join(' '));
  }
});

test('long repeated-token comparisons retain both texts near the token limit', () => {
  const a = '시작 ' + '가 나 '.repeat(700) + '끝';
  const b = '다른 ' + '나 가 '.repeat(700) + '마침';
  const d = diffWords(a, b);
  assert.equal(side(d, 'del'), a);
  assert.equal(side(d, 'add'), b);
  assert.ok(d.some(p => p.type === 'same'));
});
