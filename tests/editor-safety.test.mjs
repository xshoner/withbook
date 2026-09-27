import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { AutosaveQueue, SaveError } from '../src/lib/autosave-queue.ts';
import { charCount, contentHash, markdownToDoc, markdownToDocReport, MdCharCounter } from '../src/lib/doc/doc.ts';
import { figureAttrsFromDom, figureDataAttrs } from '../src/components/editor/figureAttrs.ts';
import { readStream, StreamStallError } from '../src/lib/client.ts';

const result = { charCount: 3, status: 'editing', updatedAt: new Date().toISOString() };
const tick = () => new Promise((r) => setImmediate(r));

function setup(save, extra = {}) {
  let local;
  const persisted = [];
  const q = new AutosaveQueue({
    save,
    persist: async (d) => { local = d; persisted.push(d); },
    acknowledge: async (token) => { if (local?.token === token) local = undefined; },
    offline: () => false,
    hash: contentHash,
    persistDelay: 0,
    ...extra,
  });
  return { q, local: () => local, persisted };
}

/* ---------- 저장 충돌 (baseHash) ---------- */

test('saves send the hash of the last server-confirmed content and advance it after success', async () => {
  const bodies = [];
  const { q } = setup(async (b) => { bodies.push(b); return result; });
  q.setBase(contentHash('server v1'));
  q.mark({ content: 'mine v2' });
  assert.equal(await q.flush(), true);
  q.mark({ content: 'mine v3' });
  assert.equal(await q.flush(), true);
  assert.equal(bodies[0].baseHash, contentHash('server v1'));
  assert.equal(bodies[1].baseHash, contentHash('mine v2'));
  assert.equal(q.base, contentHash('mine v3'));
});

test('sketch-only saves do not send a base hash; unknown base sends none (backward compatible)', async () => {
  const bodies = [];
  const { q } = setup(async (b) => { bodies.push(b); return result; });
  q.mark({ content: 'no base yet' });
  await q.flush();
  q.mark({ sketch: 'notes' });
  await q.flush();
  assert.equal('baseHash' in bodies[0], false);
  assert.equal('baseHash' in bodies[1], false);
});

test('409 conflict stops retrying, keeps the draft, and keepMine overwrites with the server hash as base', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const bodies = [];
    let conflict = true;
    const server = { content: 'edited by find/replace', hash: contentHash('edited by find/replace') };
    const { q, local } = setup(async (b) => {
      bodies.push(b);
      if (conflict) throw new SaveError('먼저 고쳤습니다', 409, server);
      return result;
    });
    q.setBase(contentHash('opened'));
    q.mark({ content: 'my edit' });
    assert.equal(await q.flush(), false);
    assert.equal(q.state.kind, 'conflict');
    assert.deepEqual(q.conflict, server);
    assert.equal(local().content, 'my edit');
    mock.timers.tick(60_000);
    await tick();
    assert.equal(bodies.length, 1, 'no automatic retry while in conflict');
    assert.equal(await q.flush(), false, 'flush does not resend while in conflict');
    q.mark({ content: 'my edit 2' }); // 계속 친 입력은 보관만 한다
    await tick();
    assert.equal(bodies.length, 1);
    assert.equal(local().content, 'my edit 2');
    conflict = false;
    assert.equal(await q.keepMine(), true);
    assert.equal(bodies.at(-1).content, 'my edit 2');
    assert.equal(bodies.at(-1).baseHash, server.hash);
    assert.equal(q.conflict, null);
    assert.equal(local(), undefined);
  } finally {
    mock.timers.reset();
  }
});

test('takeServer drops my draft and adopts the server hash', async () => {
  const server = { content: 'server', hash: contentHash('server') };
  const { q, local } = setup(async () => { throw new SaveError('충돌', 409, server); });
  q.setBase(contentHash('old'));
  q.mark({ content: 'mine' });
  await q.flush();
  await q.takeServer();
  assert.equal(q.draft, null);
  assert.equal(q.conflict, null);
  assert.equal(q.base, server.hash);
  assert.equal(local(), undefined);
  assert.equal(q.idle(), true);
});

test('drafts carry their base hash so a stale recovery copy is detectable', async () => {
  const { q, local } = setup(async () => result);
  q.setBase(contentHash('v1'));
  q.mark({ content: 'typed' });
  await tick();
  assert.equal(local().baseHash, contentHash('v1'));
});

test('an edit made during a request is re-based on the content that request saved', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const bodies = [];
  const { q, local } = setup(async (b) => { bodies.push(b); if (bodies.length === 1) await gate; return result; });
  q.setBase(contentHash('v1'));
  q.mark({ content: 'A' });
  const saving = q.flush();
  await tick();
  q.mark({ content: 'B' });
  release();
  await saving;
  assert.equal(bodies[1].baseHash, contentHash('A'));
  assert.equal(local(), undefined);
});

/* ---------- 재시도 규칙 ---------- */

test('4xx other than 408/429 is not retried automatically; 429 is', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let calls = 0;
    let status = 400;
    const { q } = setup(async () => { calls++; throw new SaveError('입력 데이터 형식이 올바르지 않습니다.', status); });
    q.mark({ content: 'bad' });
    assert.equal(await q.flush(), false);
    assert.equal(q.state.kind, 'error');
    mock.timers.tick(30_000);
    await tick();
    assert.equal(calls, 1);
    status = 429;
    assert.equal(await q.flush(), false);
    mock.timers.tick(5_000);
    await tick();
    assert.equal(calls, 3);
    q.stopTimer();
  } finally {
    mock.timers.reset();
  }
});

/* ---------- 알림·복구본 쓰기 줄이기 ---------- */

test('marking repeatedly emits dirty once (no rerender per keystroke)', async () => {
  const { q } = setup(async () => result);
  const kinds = [];
  q.subscribe((s) => kinds.push(s.kind));
  q.mark({ content: 'a' });
  q.mark({ content: 'ab' });
  q.mark({ content: 'abc' });
  assert.deepEqual(kinds, ['idle', 'dirty']);
  q.stopTimer();
});

test('recovery copies are throttled to one write per persistDelay, keeping the latest draft', async () => {
  const { q, persisted } = setup(async () => result, { persistDelay: 40 });
  q.mark({ content: 'a' });
  q.mark({ content: 'ab' });
  q.mark({ content: 'abc' });
  await tick();
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].content, 'a');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(persisted.length, 2);
  assert.equal(persisted[1].content, 'abc');
  q.stopTimer();
});

test('the sent draft is persisted before the request so acknowledgement clears the recovery copy', async () => {
  const { q, local } = setup(async () => result, { persistDelay: 10_000 });
  q.mark({ content: 'first' }); // 바로 쓴다
  q.mark({ content: 'second' }); // 묶여 대기
  assert.equal(await q.flush(), true);
  assert.equal(local(), undefined);
});

/* ---------- 그림 토큰 (분량 조정) ---------- */

const fig = (id) => ({ type: 'figure', attrs: { assetId: id, src: `/a/${id}.png` } });
const figIds = (doc) => doc.content.filter((n) => n.type === 'figure').map((n) => n.attrs.assetId);

test('mid-line figure tokens are split out instead of lost', () => {
  const { doc, report } = markdownToDocReport('첫 문단이다. ⟦그림1⟧ 이어지는 문장.\n\n둘째 문단', [fig('a')]);
  assert.deepEqual(doc.content.map((n) => n.type), ['paragraph', 'figure', 'paragraph', 'paragraph']);
  assert.deepEqual(report, { appended: 0, duplicates: 0 });
});

test('duplicate tokens insert the figure once; dropped figures are appended at the end', () => {
  const { doc, report } = markdownToDocReport('⟦그림2⟧\n\n본문\n\n⟦그림2⟧\n\n끝', [fig('a'), fig('b'), fig('c')]);
  assert.deepEqual(figIds(doc), ['b', 'a', 'c']);
  assert.equal(doc.content.at(-1).type, 'figure');
  assert.deepEqual(report, { appended: 2, duplicates: 1 });
});

test('tokens that point at no figure produce no text', () => {
  const doc = markdownToDoc('앞 ⟦그림9⟧ 뒤');
  assert.equal(figIds(doc).length, 0);
  assert.equal(charCount(doc), 2);
});

/* ---------- 쓰는 중 글자 수 ---------- */

test('incremental character counter matches charCount(markdownToDoc()) while streaming', () => {
  const md = '## 소제목 **굵게**\n\n첫 문단은 *기울임*과 각주⟦주:설명이다.⟧를 담는다.\n\n> 인용 한 줄\n> 두 줄\n\n- 목록 하나\n- 목록 둘\n1. 번호\n\n---\n\n⟦그림1⟧\n\n마지막 문단 ⟦그림2⟧ 뒤';
  const c = new MdCharCounter();
  for (let i = 1; i <= md.length; i += 7) {
    const part = md.slice(0, i);
    assert.equal(c.count(part), charCount(markdownToDoc(part)), `prefix ${i}`);
  }
  assert.equal(c.count(md), charCount(markdownToDoc(md)));
  assert.equal(c.count('다른 글'), charCount(markdownToDoc('다른 글')), 'resets when the text is replaced');
});

/* ---------- 본문 해시 ---------- */

test('contentHash is stable and distinguishes content', () => {
  const a = JSON.stringify(markdownToDoc('가나다'));
  assert.equal(contentHash(a), contentHash(String(a)));
  assert.notEqual(contentHash(a), contentHash(JSON.stringify(markdownToDoc('가나라'))));
  assert.equal(contentHash(''), contentHash(null));
});

/* ---------- 그림 복사·붙여넣기 ---------- */

function el(attrs, img) {
  return {
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    querySelector: () => (img ? { getAttribute: (n) => img[n] ?? null } : null),
  };
}

test('figure attributes survive a render → parse round trip (cut/paste)', () => {
  const attrs = { assetId: 'as1', src: '/api/assets/as1', widthPx: 2400, heightPx: 1600, layout: 'mm', widthMm: 70, caption: '그림 설명' };
  const html = figureDataAttrs(attrs);
  assert.deepEqual(figureAttrsFromDom(el(html, { src: attrs.src })), attrs);
});

test('legacy figure HTML (data-asset + img only) still parses with the image address', () => {
  const back = figureAttrsFromDom(el({ 'data-asset': 'old' }, { src: '/x.png' }));
  assert.equal(back.assetId, 'old');
  assert.equal(back.src, '/x.png');
  assert.equal(back.layout, 'fit');
  assert.equal(back.caption, '');
});

/* ---------- 스트림 멈춤 ---------- */

const enc = new TextEncoder();
function streamResponse(lines, { hang = true } = {}) {
  return new Response(new ReadableStream({
    start(ctrl) {
      for (const l of lines) ctrl.enqueue(enc.encode(JSON.stringify(l) + '\n'));
      if (!hang) ctrl.close();
    },
  }), { status: 200 });
}

test('readStream gives up with StreamStallError when the stream goes silent', async () => {
  const events = [];
  await assert.rejects(
    readStream(streamResponse([{ t: 'status', v: '구상 중…' }]), (e) => events.push(e), { stallMs: 30 }),
    StreamStallError,
  );
  assert.equal(events.length, 1);
});

test('readStream without a stall limit reads a normal stream to the end', async () => {
  const events = [];
  await readStream(streamResponse([{ t: 'delta', v: '글' }, { t: 'done', chars: 1 }], { hang: false }), (e) => events.push(e.t));
  assert.deepEqual(events, ['delta', 'done']);
});
