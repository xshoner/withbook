import test from 'node:test';
import assert from 'node:assert/strict';
import { charCount, docToMarkdown, findFootnotes, markdownToDoc, textblocks } from '../src/lib/doc/doc.ts';
import { validDocument } from '../src/lib/section-input.ts';
import { docToHtml } from '../src/lib/print/render.ts';

test('AI footnote tokens become footnote nodes attached to the preceding word', () => {
  const doc = markdownToDoc('요즘 **생성형 AI**⟦주:사람의 요청에 따라 새 글을 만드는 인공지능이다.⟧가 흔하다.');
  const [fn] = findFootnotes(doc);
  assert.equal(fn.attrs.note, '사람의 요청에 따라 새 글을 만드는 인공지능이다.');
  assert.equal(fn.attrs.term, 'AI');
  assert.equal(fn.attrs.auto, true);
  // 각주는 본문 글자 수·교정 문단 텍스트에 섞이지 않는다
  assert.equal(textblocks(doc)[0].text, '요즘 생성형 AI가 흔하다.');
  assert.equal(charCount(doc), '요즘 생성형 AI가 흔하다.'.length);
});

test('footnotes survive the markdown round trip used by length adjustment', () => {
  const doc = markdownToDoc('알고리즘⟦주:문제를 푸는 절차다.⟧을 배운다.');
  const back = markdownToDoc(docToMarkdown(doc).md);
  assert.deepEqual(findFootnotes(back).map((f) => f.attrs.note), ['문제를 푸는 절차다.']);
});

test('footnote documents validate and print as escaped Paged.js footnotes', () => {
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '단어' }, { type: 'footnote', attrs: { note: '<b>주석</b>', term: '단어', auto: false } }] }] };
  assert.equal(validDocument(JSON.stringify(doc)), true);
  const html = docToHtml(doc, { chapterNo: 1, counter: { n: 0 } });
  assert.equal(html, '<p>단어<span class="fn">&lt;b&gt;주석&lt;/b&gt;</span></p>');
});
