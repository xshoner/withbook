import test from 'node:test';
import assert from 'node:assert/strict';
import { AutosaveQueue } from '../src/lib/autosave-queue.ts';

const result = { charCount: 3, status: 'editing', updatedAt: new Date().toISOString() };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));

function setup(save) {
  let local;
  const q = new AutosaveQueue({ save, persist: async d => { local = d; },
    acknowledge: async token => { if (local?.token === token) local = undefined; }, offline: () => false });
  return { q, local: () => local };
}

test('concurrent flushes serialize and preserve edits made during a request', async () => {
  const first = deferred(); const bodies = [];
  const { q, local } = setup(async body => { bodies.push(body); if (bodies.length === 1) await first.promise; return result; });
  q.mark({ content: 'old', sketch: 'notes' });
  const a = q.flush();
  q.mark({ content: 'new' });
  const b = q.flush();
  await tick();
  assert.equal(bodies.length, 1);
  assert.equal(local().content, 'new');
  assert.equal(local().sketch, 'notes');
  first.resolve();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].content, 'new');
  assert.equal(local(), undefined);
  assert.equal(q.state.kind, 'saved');
});

test('failed requests retain all fields and recover on retry', async () => {
  let fail = true;
  const { q, local } = setup(async () => { if (fail) throw new Error('offline'); return result; });
  q.mark({ content: 'manuscript' });
  assert.equal(await q.flush(), false);
  q.mark({ sketch: 'new notes' });
  await tick();
  assert.equal(local().content, 'manuscript');
  fail = false;
  assert.equal(await q.flush(), true);
  assert.equal(local(), undefined);
});

test('switching sections cannot send old section content to the new section', async () => {
  const gate = deferred(); const a = []; const b = [];
  const old = setup(async patch => { await gate.promise; a.push(patch); return result; });
  const next = setup(async patch => { b.push(patch); return result; });
  old.q.mark({ content: 'section A' });
  const saving = old.q.flush();
  next.q.mark({ content: 'section B' });
  await next.q.flush(); gate.resolve(); await saving;
  assert.equal(a[0].content, 'section A'); assert.equal(b[0].content, 'section B');
});

test('remount subscriptions receive only their own section acknowledgements', async () => {
  const gate = deferred(); const oldEvents = []; const newEvents = [];
  const { q } = setup(async () => { await gate.promise; return result; });
  const leave = q.subscribe(s => oldEvents.push(s.kind));
  q.mark({ content: 'draft' }); const saving = q.flush(); leave();
  q.subscribe(s => newEvents.push(s.kind)); gate.resolve(); await saving;
  assert.equal(oldEvents.includes('saved'), false); assert.equal(newEvents.at(-1), 'saved');
});
