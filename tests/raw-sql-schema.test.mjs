import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 운영(Supabase 풀러)에서는 원시 SQL이 public 스키마를 보므로 `relation "Section" does not exist`가 났다 — 표 이름은 rawTable()로만 쓴다
async function* tsFiles(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* tsFiles(p);
    else if (/\.tsx?$/.test(e.name)) yield p;
  }
}

test('raw SQL never names a table without its schema', async () => {
  const bad = [];
  for await (const f of tsFiles(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
    const src = await readFile(f, 'utf8');
    for (const m of src.matchAll(/\$(?:queryRaw|executeRaw)(?:Unsafe)?[^`]*`([^`]*)`/g)) {
      if (/\b(FROM|JOIN|UPDATE|INTO)\s+"[A-Za-z]+"(?!\.)/i.test(m[1])) bad.push(`${f}: ${m[1].trim().slice(0, 80)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('dbSchema reads schema= from the connection string', async () => {
  const { dbSchema } = await import('../src/lib/db.ts');
  assert.equal(dbSchema('postgresql://u:p@h:6543/postgres?pgbouncer=true&connection_limit=5&schema=withbook'), 'withbook');
  assert.equal(dbSchema('postgresql://u:p%23x@h:5432/postgres?schema=smoke_123'), 'smoke_123');
  assert.equal(dbSchema('postgresql://u:p@h:5432/postgres'), 'public');
  assert.equal(dbSchema('postgresql://h/db?schema=a";drop'), 'public'); // 이상한 이름은 쓰지 않는다
});
