import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { buildBackupZip } from '../src/lib/export/backup-zip.ts';
import { extraKeysFor, remapExtras } from '../src/lib/export/backup-extras.ts';

test('backup extras keep cover, references, outlines and figures and move them to the new ids', () => {
  const keys = extraKeysFor('p1', ['s1', 's2']);
  assert.ok(keys.exact.includes('cover:p1') && keys.exact.includes('outline-edit:s2') && keys.exact.includes('figure-ai:s1'));
  assert.deepEqual(keys.prefixes, ['ref:s1:', 'ref:s2:']);
  const rows = [
    { key: 'cover:p1', value: '{"images":{"front":{"assetId":"a1"}}}' },
    { key: 'ref:s1:r9', value: '자료' },
    { key: 'outline-edit:s2', value: '개요' },
    { key: 'figure-ai:s1', value: '[{"assetId":"a1"}]' },
    { key: 'ref:unknown:r1', value: '다른 책' }, // 옛 절을 모르면 버린다
    { key: 'ai:settings', value: 'secret' }, // 허용하지 않은 키는 버린다
  ];
  const out = remapExtras(rows, 'P2', new Map([['s1', 'S1'], ['s2', 'S2']]), (v) => v.split('a1').join('A1'));
  assert.deepEqual(out, [
    { key: 'cover:P2', value: '{"images":{"front":{"assetId":"A1"}}}' },
    { key: 'ref:S1:r9', value: '자료' },
    { key: 'outline-edit:S2', value: '개요' },
    { key: 'figure-ai:S1', value: '[{"assetId":"A1"}]' },
  ]);
  assert.deepEqual(remapExtras(undefined, 'P2', new Map(), (v) => v), []);
});

test('backup zip writes extras and a manifest listing images missing from storage', async () => {
  const buf = await buildBackupZip({
    head: { title: '책', assets: [] },
    chapterIds: ['c1'],
    loadChapter: async (id) => ({ id, sections: [] }),
    assets: [
      { name: 'assets/a1.png', load: async () => Buffer.from([1, 2, 3]) },
      { name: 'assets/a2.png', load: async () => null },
      { name: 'assets/a3.png', load: async () => { throw new Error('storage down'); } },
    ],
    tail: [
      { name: 'extras.json', build: async () => Buffer.from('{"rows":[]}') },
      { name: 'manifest.json', build: async (missing) => Buffer.from(JSON.stringify({ missingImages: missing })) },
    ],
  });
  const zip = await JSZip.loadAsync(buf);
  assert.equal(JSON.parse(await zip.file('project.json').async('string')).project.chapters[0].id, 'c1');
  assert.deepEqual(JSON.parse(await zip.file('manifest.json').async('string')).missingImages, ['assets/a2.png', 'assets/a3.png']);
  assert.equal((await zip.file('assets/a1.png').async('nodebuffer')).length, 3);
});
