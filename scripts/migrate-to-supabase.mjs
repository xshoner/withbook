// 로컬(SQLite + data 폴더) → Supabase(Postgres + Storage + Auth) 이전. 여러 번 실행해도 안전(이미 있는 항목은 건너뜀).
//
// 필요한 환경변수 (.env 또는 실행 시 지정):
//   DIRECT_URL                 Supabase 직접 연결 문자열 (…:5432/postgres?schema=withbook)
//   NEXT_PUBLIC_SUPABASE_URL   https://<project>.supabase.co
//   SUPABASE_SECRET_KEY        sb_secret_… (서버 전용 비밀 키)
//   ADMIN_EMAIL, ADMIN_PASSWORD  최초 슈퍼관리자 (비밀번호는 저장하지 않고 Supabase Auth에만 전달)
// 선택: SQLITE_PATH(기본 data/app.db), STYLE_REFERENCE_DIR(기본 ./style reference)
//
// 실행: node --env-file=.env scripts/migrate-to-supabase.mjs   (--db-only: 저장소·계정 없이 DB만 — 검증용)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`환경변수 ${k}가 필요합니다.`); process.exit(1); } return v; };
const DB_ONLY = process.argv.includes('--db-only');
const DIRECT_URL = need('DIRECT_URL');
const SUPABASE_URL = DB_ONLY ? '' : need('NEXT_PUBLIC_SUPABASE_URL');
const SECRET = DB_ONLY ? '' : need('SUPABASE_SECRET_KEY');
const log = (...a) => console.log('•', ...a);

// 1) 표 만들기 (withbook 스키마)
log('DB 스키마 반영 (prisma db push)');
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], {
  stdio: 'inherit', env: { ...process.env, DATABASE_URL: DIRECT_URL, DIRECT_URL },
});
const db = new PrismaClient({ datasourceUrl: DIRECT_URL });

// 2) 보안: withbook 스키마를 공개 키(Data API)에서 막고, 모든 표에 RLS를 켠다 (서버는 postgres 역할로 접속)
log('스키마 접근 제한 · RLS');
await db.$executeRawUnsafe(`REVOKE ALL ON SCHEMA withbook FROM anon, authenticated`).catch((e) => log('  (권한 조정 건너뜀)', e.message));
const tables = await db.$queryRawUnsafe(`SELECT tablename FROM pg_tables WHERE schemaname = 'withbook'`);
for (const { tablename } of tables) {
  await db.$executeRawUnsafe(`ALTER TABLE withbook."${tablename}" ENABLE ROW LEVEL SECURITY`);
  await db.$executeRawUnsafe(`REVOKE ALL ON withbook."${tablename}" FROM anon, authenticated`).catch(() => {});
}

// 3) 저장소 버킷
const sb = DB_ONLY ? null : createClient(SUPABASE_URL, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
const BUCKETS = { assets: false, 'style-reference': false, exports: false, incoming: false, fonts: true };
const existing = new Set(DB_ONLY ? Object.keys(BUCKETS) : ((await sb.storage.listBuckets()).data ?? []).map((b) => b.name));
for (const [name, isPublic] of Object.entries(BUCKETS)) {
  if (existing.has(name)) continue;
  const { error } = await sb.storage.createBucket(name, { public: isPublic, fileSizeLimit: '50MB' });
  if (error) throw new Error(`버킷 ${name}: ${error.message}`);
  log('버킷 생성', name, isPublic ? '(공개)' : '(비공개)');
}
const upload = async (bucket, key, buf, contentType) => {
  if (DB_ONLY) return;
  const { error } = await sb.storage.from(bucket).upload(key, buf, { upsert: true, contentType });
  if (error) throw new Error(`${bucket}/${key}: ${error.message}`);
};

// 4) 원고 데이터 (SQLite → Postgres)
const sqlitePath = process.env.SQLITE_PATH || 'data/app.db';
if (fs.existsSync(sqlitePath)) {
  const src = new DatabaseSync(sqlitePath, { readOnly: true });
  const rows = (t) => src.prepare(`SELECT * FROM "${t}"`).all().map((r) => ({ ...r }));
  const date = (v) => (v === null || v === undefined ? v : new Date(typeof v === 'number' ? v : Date.parse(v)));
  const dates = (r, keys) => { for (const k of keys) if (k in r) r[k] = date(r[k]); return r; };
  const copy = async (model, table, dateKeys = [], fix = (r) => r) => {
    const data = rows(table).map((r) => fix(dates(r, dateKeys)));
    if (!data.length) return;
    const res = await db[model].createMany({ data, skipDuplicates: true });
    log(`${table}: ${res.count}/${data.length}개 옮김 (나머지는 이미 있음)`);
  };
  await copy('project', 'Project', ['createdAt', 'updatedAt', 'deletedAt']);
  await copy('tocReport', 'TocReport', ['createdAt']);
  await copy('chapter', 'Chapter');
  await copy('section', 'Section', ['updatedAt']);
  await copy('version', 'Version', ['createdAt']);
  await copy('glossary', 'Glossary');
  await copy('aiLog', 'AiLog', ['createdAt'], (r) => ({ ...r, instructionIncluded: Boolean(r.instructionIncluded) }));
  // 이미지: 파일을 assets 버킷에 올리고 경로를 저장소 키로 바꾼다
  for (const a of rows('Asset')) {
    const key = `projects/${a.projectId}/${a.id}${path.extname(a.path)}`;
    const buf = fs.existsSync(a.path) ? fs.readFileSync(a.path) : null;
    if (buf) await upload('assets', key, buf, a.mime);
    else log('  이미지 파일 없음(건너뜀):', a.path);
    await db.asset.createMany({ data: [{ ...dates(a, ['createdAt']), path: key }], skipDuplicates: true });
  }
  log('이미지', rows('Asset').length, '개 처리');
} else log('SQLite 파일이 없어 원고 이전을 건너뜁니다:', sqlitePath);

// 5) 글꼴 (공개 fonts 버킷 — git에는 올리지 않는다)
for (const f of ['KoPubBatangLight.ttf', 'KoPubBatangBold.ttf', 'KoPubDotumMedium.ttf']) {
  const p = path.join('public', 'fonts', f);
  if (fs.existsSync(p)) { await upload('fonts', f, fs.readFileSync(p), 'font/ttf'); log('글꼴', f); }
}

// 6) 문체 학습 자료 (비공개 style-reference 버킷, 한글 파일명은 base64url 키)
const refDir = process.env.STYLE_REFERENCE_DIR || './style reference';
if (fs.existsSync(refDir)) {
  for (const n of fs.readdirSync(refDir)) {
    if (!/\.(txt|md|pdf|docx|hwpx)$/i.test(n)) continue;
    await upload('style-reference', Buffer.from(n, 'utf8').toString('base64url'), fs.readFileSync(path.join(refDir, n)), 'application/octet-stream');
    log('학습 자료', n);
  }
}

// 7) 전역 설정: 기본 문체 프로필 · AI 연결(.env 값 그대로) · instruction.md
const setIfMissing = async (key, value) => {
  if (value === undefined || value === null) return;
  const has = await db.appSetting.findUnique({ where: { key } });
  if (has) return log(`설정 ${key}: 이미 있음(유지)`);
  await db.appSetting.create({ data: { key, value: JSON.stringify(value) } });
  log(`설정 ${key}: 저장`);
};
const stylePath = path.join(process.env.DATA_DIR || 'data', 'style-profile.json');
if (fs.existsSync(stylePath)) await setIfMissing('globalStyle', JSON.parse(fs.readFileSync(stylePath, 'utf8')));
if (process.env.LLM_BASE_URL) {
  await setIfMissing('ai', {
    provider: 'gateway', keyName: 'LLM_API_KEY', model: process.env.LLM_MODEL || 'claude-fable-5-1',
    baseUrl: process.env.LLM_BASE_URL.replace(/\/+$/, ''), authScheme: (process.env.LLM_AUTH_SCHEME || 'x-api-key').toLowerCase() === 'bearer' ? 'bearer' : 'x-api-key',
    apiKey: process.env.LLM_API_KEY || '', maxOutputTokens: 32000,
  });
}
const insPath = process.env.INSTRUCTION_PATH || './instruction.md';
if (fs.existsSync(insPath)) await setIfMissing('instruction', fs.readFileSync(insPath, 'utf8'));

// 8) 최초 슈퍼관리자
if (!DB_ONLY && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
  let user = null;
  for (let page = 1; page < 20 && !user; page++) {
    const { data } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    user = data?.users?.find((u) => u.email?.toLowerCase() === email) ?? null;
    if (!data?.users?.length) break;
  }
  if (!user) {
    const { data, error } = await sb.auth.admin.createUser({ email, password: process.env.ADMIN_PASSWORD, email_confirm: true, app_metadata: { role: 'superadmin' } });
    if (error) throw new Error('관리자 계정 생성 실패: ' + error.message);
    user = data.user;
    log('슈퍼관리자 계정 생성', email);
  } else {
    await sb.auth.admin.updateUserById(user.id, { app_metadata: { ...user.app_metadata, role: 'superadmin' } });
    log('슈퍼관리자 계정 확인(비밀번호는 그대로 둠)', email);
  }
  await db.appUser.upsert({ where: { email }, create: { email, role: 'superadmin', authId: user.id }, update: { role: 'superadmin', authId: user.id } });
}

await db.$disconnect();
log('완료');
