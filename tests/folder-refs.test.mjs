import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFolderIndex, chunkText, pickFolderRefs } from '../src/lib/ai/folder-refs.ts';

test('chunkText keeps paragraphs together and splits long ones', () => {
  const parts = chunkText(['가'.repeat(10), '나'.repeat(10), '다'.repeat(25)].join('\n\n'), 22);
  assert.deepEqual(parts, ['가'.repeat(10) + '\n' + '나'.repeat(10), '다'.repeat(22), '다'.repeat(3)]);
  assert.ok(parts.every((p) => p.length <= 22));
});

test('pickFolderRefs returns passages close to the section, in file order', () => {
  const index = buildFolderIndex([
    { name: '요리/김치.txt', text: '배추김치는 소금에 절인 배추에 고춧가루 양념을 버무려 담근다.\n\n김장은 겨울을 나기 위해 김치를 한꺼번에 담그는 일이다.' },
    { name: '여행/제주.md', text: '제주 올레길은 해안을 따라 걷는 도보 여행길이다.' },
    { name: '잡담.txt', text: '오늘은 날씨가 맑았다.' },
  ]);
  const got = pickFolderRefs(index, '김장과 배추김치 담그기');
  assert.equal(got.length, 1);
  assert.match(got[0].name, /^내 폴더 · 요리\/김치\.txt/);
  assert.match(got[0].text, /배추김치/);
  assert.deepEqual(pickFolderRefs(index, 'zzz qqq'), []);
  assert.deepEqual(pickFolderRefs(buildFolderIndex([]), '김치'), []);
});

test('file name counts as a match and budget caps the passages', () => {
  const long = Array.from({ length: 20 }, (_, i) => `${i}번째 문단 반도체 공정 이야기 `.repeat(40)).join('\n');
  const index = buildFolderIndex([{ name: '반도체.txt', text: long }]);
  const got = pickFolderRefs(index, '반도체', 3000);
  assert.ok(got.length >= 1 && got.length < 20);
  assert.ok(got.reduce((a, g) => a + g.text.length, 0) < 3000 + 1500);
  assert.ok(got.every((g) => g.name.includes('번째 대목')));
});
