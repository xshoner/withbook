// DB 백업 올리기 — GitHub Actions(.github/workflows/db-backup.yml)가 암호화한 pg_dump 파일을 넘긴다.
// Supabase Storage의 비공개 `backups` 버킷(없으면 만든다)에 올리고, 최근 KEEP개만 남긴다.
// 사용: NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SECRET_KEY=… node scripts/backup-db.mjs backup.dump.gpg
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const KEEP = 12; // 주 1회 → 약 석 달
const BUCKET = 'backups';
const file = process.argv[2];
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
if (!file || !url || !key) {
  console.error('사용: NEXT_PUBLIC_SUPABASE_URL·SUPABASE_SECRET_KEY를 넣고 node scripts/backup-db.mjs <파일>');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });
const { error: be } = await sb.storage.createBucket(BUCKET, { public: false });
if (be && !/exist/i.test(be.message)) throw be;

const name = `db/withbook-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.dump.gpg`;
const data = await readFile(file);
const { error: ue } = await sb.storage.from(BUCKET).upload(name, data, { contentType: 'application/octet-stream', upsert: false });
if (ue) throw ue;
console.log(`올림: ${BUCKET}/${name} (${(data.length / 1024 / 1024).toFixed(2)}MB)`);

const { data: list, error: le } = await sb.storage.from(BUCKET).list('db', { limit: 1000, sortBy: { column: 'name', order: 'desc' } });
if (le) throw le;
const old = (list ?? []).filter((f) => f.name.endsWith('.dump.gpg')).slice(KEEP).map((f) => `db/${f.name}`);
if (old.length) {
  const { error: de } = await sb.storage.from(BUCKET).remove(old);
  if (de) throw de;
  console.log(`오래된 백업 ${old.length}개 지움`);
}
