import test from 'node:test';
import assert from 'node:assert/strict';
import { editStats, pickLearningPairs, sentences } from '../src/lib/style/edits.ts';

test('sentences split on Korean sentence ends and newlines', () => {
  assert.deepEqual(sentences('첫 문장이다. 둘째 문장이다!\n셋째'), ['첫 문장이다.', '둘째 문장이다!', '셋째']);
});

test('editStats: unchanged text is 0%, fully rewritten is 100%, pairs align edits', () => {
  const ai = '오늘은 날씨가 좋다. 우리는 산책을 했다. 그것은 매우 중요한 경험이었다.';
  assert.equal(editStats(ai, ai).rate, 0);
  assert.equal(editStats(ai, '전혀 다른 글.').rate, 100);
  const r = editStats(ai, '오늘은 날씨가 좋다. 우리는 산책을 했다. 그날의 걸음은 오래 남았다.');
  assert.ok(r.rate > 0 && r.rate < 60, String(r.rate));
  assert.deepEqual(r.pairs, [{ ai: '그것은 매우 중요한 경험이었다.', author: '그날의 걸음은 오래 남았다.' }]);
});

test('pickLearningPairs keeps comparable rewrites within the size budget', () => {
  const pairs = [
    { ai: '그것은 매우 중요한 경험이었다고 할 수 있다.', author: '그날의 걸음은 오래 남았다.' },
    { ai: '', author: '작가가 새로 쓴 문단' },
    { ai: '짧다', author: '짧은 수정' },
  ];
  assert.equal(pickLearningPairs(pairs).length, 1);
  assert.equal(pickLearningPairs(pairs, 10).length, 0);
});
