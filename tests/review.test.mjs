import test from 'node:test';
import assert from 'node:assert/strict';
import { betaSchema, consistencySchema, mapBetaRefs, mapConsistencyRefs } from '../src/lib/ai/review-shape.ts';
import { scopeForPurpose } from '../src/lib/ai/routing.ts';

const index = [
  { sectionId: 'a1', chapterId: 'A', label: '1.1', title: '첫 절', chapterTitle: '1장 시작' },
  { sectionId: 'a2', chapterId: 'A', label: '1.2', title: '둘째 절', chapterTitle: '1장 시작' },
  { sectionId: 'b1', chapterId: 'B', label: '2.1', title: '셋째 절', chapterTitle: '2장 전개' },
];

test('consistency refs map section and chapter numbers to sections, sorted by severity', () => {
  const raw = consistencySchema.parse({
    overview: ' 전체적으로 무난하다 ',
    items: [
      { type: 'repetition', severity: 'low', title: '같은 일화', detail: 'd', refs: ['S1', '[S3]', 'S1', 'S9'] },
      { type: 'weird', severity: 'high', title: '수치가 다름', refs: ['C2'] },
      { type: 'terminology', title: '', detail: '' },
    ],
  });
  const r = mapConsistencyRefs(raw, index);
  assert.equal(r.overview, '전체적으로 무난하다');
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map((i) => [i.severity, i.type]), [['high', 'other'], ['low', 'repetition']]);
  assert.deepEqual(r.items[0].refs.map((x) => x.sectionId), ['b1']);
  assert.deepEqual(r.items[1].refs.map((x) => x.sectionId), ['a1', 'b1']);
});

test('consistency schema tolerates missing or odd fields', () => {
  const r = mapConsistencyRefs(consistencySchema.parse({ items: 'none' }), index);
  assert.deepEqual(r, { overview: '', items: [] });
});

test('beta reader refs point at section paragraphs and keep only quotes that really appear', () => {
  const blocks = [['첫 문단입니다.', '둘째 문단은 조금 늘어집니다.'], ['다른 절'], ['셋째 절 첫 문단']];
  const raw = betaSchema.parse({
    overall: '읽을 만하다',
    engagement: '4',
    drags: [{ ref: 'S1-2', quote: '“조금 늘어집니다”', why: '반복' }, { ref: 'S9-1', why: '없는 곳' }, { ref: '', quote: '', why: '' }],
    unclear: [{ ref: 'S3-1', quote: '원고에 없는 말', why: '용어' }],
    questions: [{ ref: '', question: '그래서 어떻게 하나?' }, { question: '  ' }],
    strengths: [' 도입이 좋다 ', ''],
  });
  const r = mapBetaRefs(raw, index, blocks);
  assert.equal(r.engagement, 4);
  assert.deepEqual(r.drags[0].place, { sectionId: 'a1', label: '1.1', title: '첫 절', paragraph: 2, text: '조금 늘어집니다' });
  assert.equal(r.drags[1].place, null);
  assert.equal(r.drags.length, 2);
  assert.equal(r.unclear[0].place.text, '');
  assert.equal(r.unclear[0].place.sectionId, 'b1');
  assert.deepEqual(r.questions, [{ place: null, question: '그래서 어떻게 하나?' }]);
  assert.deepEqual(r.strengths, ['도입이 좋다']);
  assert.equal(mapBetaRefs(betaSchema.parse({ engagement: 'x' }), index, blocks).engagement, 0);
});

test('new review purposes use the revision connection', () => {
  assert.equal(scopeForPurpose('consistency'), 'revision');
  assert.equal(scopeForPurpose('beta_reader'), 'revision');
  assert.equal(scopeForPurpose('rewrite_custom'), 'revision');
});
