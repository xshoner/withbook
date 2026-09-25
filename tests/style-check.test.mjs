import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStyle, classifyEnding, maskQuotes, splitSentences, stem } from '../src/lib/style/check.ts';

const sec = (id, paragraphs) => ({ sectionId: id, label: id, title: `절 ${id}`, paragraphs });
const sentences = (t) => splitSentences(t).map(([s, e]) => t.slice(s, e));

test('splitSentences splits on enders but not decimals', () => {
  assert.deepEqual(sentences('매출이 3.5% 늘었다. 정말일까? 그렇다!'), ['매출이 3.5% 늘었다.', '정말일까?', '그렇다!']);
  assert.deepEqual(sentences('첫 줄이다\n둘째 줄이다.'), ['첫 줄이다', '둘째 줄이다.']);
});

test('classifyEnding', () => {
  assert.equal(classifyEnding('그는 집으로 돌아갔다.'), 'da');
  assert.equal(classifyEnding('이것이 핵심입니다.'), 'sumnida');
  assert.equal(classifyEnding('정말 그렇습니까?'), 'sumnida');
  assert.equal(classifyEnding('이렇게 하면 돼요.'), 'yo');
  assert.equal(classifyEnding('그렇죠?'), 'yo');
  assert.equal(classifyEnding('왜 그랬을까?'), 'other');
  assert.equal(classifyEnding('제1장 시작'), 'other');
});

test('maskQuotes keeps length and hides dialogue', () => {
  const t = '그가 “가자요. 빨리요.”라고 말했다.';
  const m = maskQuotes(t);
  assert.equal(m.length, t.length);
  assert.ok(!m.includes('가자요'));
  assert.deepEqual(splitSentences(m).length, 1);
  assert.equal(classifyEnding(m), 'da');
});

test('endings: dominant style, mismatches with locations, dialogue ignored', () => {
  const r = checkStyle([
    sec('a', ['', '그는 아침 일찍 집을 나섰다. 길은 아직 어두웠다.', '“어디 가세요?” 할머니가 물었다.']),
    sec('b', ['시장은 사람들로 붐볐다. 여기가 제일 유명한 가게입니다. 모두 줄을 섰다.', '가격은 생각보다 비쌌어요.']),
  ]);
  assert.equal(r.endings.dominant, 'da');
  assert.equal(r.endings.total.da, 5);
  assert.equal(r.endings.mismatchTotal, 2);
  const g = r.endings.mismatches.find((x) => x.sectionId === 'b');
  assert.deepEqual(g.items.map((i) => [i.paragraph, i.style, i.sentence]), [
    [1, 'sumnida', '여기가 제일 유명한 가게입니다.'],
    [2, 'yo', '가격은 생각보다 비쌌어요.'],
  ]);
  assert.ok(g.items.every((i) => i.text.length <= 40));
  assert.ok(!r.endings.mismatches.some((x) => x.sectionId === 'a'));
  assert.deepEqual(r.sections.find((s) => s.sectionId === 'b').counts, { da: 2, yo: 1, sumnida: 1, other: 0 });
});

test('repeats: frequent 어절 n-grams with locations, stopword-only grams skipped', () => {
  const p = '우리는 결국 새로운 길을 찾았다. 그래서 새로운 길을 따라 걸었다.';
  const r = checkStyle([sec('a', [p, '또 새로운 길을 만났다.', '수 있는 것 수 있는 것 수 있는 것.'])]);
  const g = r.repeats.find((x) => x.gram === '새로운 길을');
  assert.ok(g, JSON.stringify(r.repeats));
  assert.equal(g.count, 3);
  assert.deepEqual(g.locations.map((l) => l.paragraph), [1, 1, 2]);
  assert.equal(g.locations[0].text, '새로운 길을');
  assert.ok(!r.repeats.some((x) => x.gram === '수 있는'));
});

test('connectives: counted per 1,000 sentences and flagged', () => {
  const ps = Array.from({ length: 10 }, (_, i) => `그리고 그는 ${i}번째 문을 열었다.`);
  const r = checkStyle([sec('a', ps)]);
  const c = r.connectives.find((x) => x.word === '그리고');
  assert.equal(c.count, 10);
  assert.equal(r.sentenceTotal, 10);
  assert.equal(c.perThousand, 1000);
  assert.equal(c.flagged, true);
  assert.equal(c.locations.length, 5);
});

test('inParagraph: same content word 3+ times in one paragraph (particles stripped)', () => {
  assert.equal(stem('기술은'), '기술');
  const r = checkStyle([sec('a', ['기술은 중요하다. 기술을 배우면 기술이 는다. 것 것 것.', '기술은 한 번만.'])]);
  assert.deepEqual(r.inParagraph.map((x) => [x.paragraph, x.word, x.count, x.text]), [[1, '기술', 3, '기술은']]);
});

test('classifyEnding: 아니다 is -다, check markers are not endings', async () => {
  const { classifyEnding } = await import('../src/lib/style/check.ts');
  assert.equal(classifyEnding('그런 것은 아니다.'), 'da');
  assert.equal(classifyEnding('늘었다[확인 필요].'), 'da');
  assert.equal(classifyEnding('이것은 책입니다.'), 'sumnida');
  assert.equal(classifyEnding('그렇지 않습니다.'), 'sumnida');
  assert.equal(classifyEnding('좋아요.'), 'yo');
});
