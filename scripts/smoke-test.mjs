import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { chromium } from 'playwright-core';
import JSZip from 'jszip';

// A fresh database for every run. Never opens the author's database.
const dir = path.resolve('test-results', `smoke-${Date.now()}`);
await fs.mkdir(dir, { recursive: true });
const port = Number(process.env.SMOKE_PORT || 3199);
const origin = `http://127.0.0.1:${port}`;
const base = process.env.SMOKE_DATABASE_URL;
if (!base) throw new Error('SMOKE_DATABASE_URL (테스트용 Postgres 주소)가 필요합니다.');
const schema = `smoke_${Date.now()}`;
const dbURL = `${base}${base.includes('?') ? '&' : '?'}schema=${schema}`;
const web = false;
const request = (url, init = {}) => fetch(url, init);
// Supabase 변수는 비워 로컬 저장소(data 폴더)를 쓰게 한다
const env = { ...process.env, DATABASE_URL: dbURL, DIRECT_URL: dbURL, DATA_DIR: dir, APP_ACCESS_MODE: 'local', APP_ORIGIN: origin, INTERNAL_APP_URL: origin, NEXT_PUBLIC_SUPABASE_URL: '', SUPABASE_SECRET_KEY: '' };
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env, stdio: 'pipe' });
const db = new PrismaClient({ datasourceUrl: dbURL });
const project = await db.project.create({ data: { title: '자동 검증 원고', chapters: { create: {
  order: 1, title: '검증 장', sections: { create: [{ order: 1, title: '첫 절' }, { order: 2, title: '둘째 절' }] },
} } }, include: { chapters: { include: { sections: { orderBy: { order: 'asc' } } } } } });
const [one, two] = project.chapters[0].sections;
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
server.stdout.on('data', d => { logs += d; }); server.stderr.on('data', d => { logs += d; });
let browser;
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await request(origin)).ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  assert.ok(ready, 'server ready');
  const send = (url, json, headers = {}) => request(origin + url, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(json) });
  assert.equal((await send(`/api/sections/${one.id}`, { content: 'malformed' })).status, 400);
  assert.equal((await send(`/api/sections/${one.id}`, { sketch: 'blocked' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await send(`/api/sections/missing`, { sketch: 'x' })).status, 404);
  browser = await chromium.launch({ channel: process.env.SMOKE_BROWSER || 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(`${origin}/projects/${project.id}?s=${one.id}`);
  async function waitContent(id, expected) {
    for (let i = 0; i < 50; i++) {
      const saved = await db.section.findUniqueOrThrow({ where: { id } });
      if (saved.content.includes(expected)) return;
      await page.waitForTimeout(200);
    }
    throw new Error('Missing saved content: ' + expected + '\n' + await page.locator('body').innerText());
  }
  const editor = page.locator('.tiptap');
  await editor.waitFor();
  await editor.fill('자동저장 검증 문장입니다. [확인 필요] 두 번째 문장입니다.');
  await waitContent(one.id, '자동저장 검증');
  await page.getByLabel('본문 찾기').fill('확인 필요');
  await page.getByRole('button', { name: '다음', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '1 / 1개' }).waitFor();
  await context.setOffline(true);
  await editor.fill('오프라인에서도 보관되는 새 원고입니다.');
  await page.waitForTimeout(1500);
  await context.setOffline(false);
  await waitContent(one.id, '오프라인에서도');
  await editor.fill('절 전환 직전 최신 문장입니다.');
  await page.getByTitle('다음 절 (Ctrl+↓)', { exact: true }).click();
  await page.waitForTimeout(500);
  await editor.waitFor();
  await editor.fill('둘째 절의 독립된 원고입니다.');
  await waitContent(two.id, '둘째 절의');
  await waitContent(one.id, '절 전환 직전');
  const first = await db.section.findUniqueOrThrow({ where: { id: one.id } });
  assert.ok(first.content.includes('절 전환 직전'));
  assert.ok(!first.content.includes('둘째 절의'));
  assert.ok(await db.version.count({ where: { sectionId: one.id, reason: 'autosave' } }));
  // Simulate closing the page before a failed save can reach the server.
  const blocked = `${origin}/api/sections/${two.id}`;
  await page.route(blocked, route => route.request().method() === 'PUT' ? route.abort() : route.continue());
  await editor.fill('새로고침 후 복구되는 원고입니다.');
  await page.waitForTimeout(1300);
  await page.reload();
  await editor.waitFor();
  assert.ok((await editor.innerText()).includes('새로고침 후 복구되는'));
  await page.unroute(blocked);
  await editor.press('Control+s');
  await waitContent(two.id, '새로고침 후 복구되는');
  await page.screenshot({ path: path.join(dir, 'editor.png'), fullPage: true });
  await page.getByRole('button', { name: '펼침면 미리보기', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(f => f.contentWindow?.__PAGED_DONE === true), null, { timeout: 60000 });
  assert.deepEqual(errors, []);
  const zip = await request(`${origin}/api/projects/${project.id}/backup`);
  assert.equal(zip.status, 200);
  const form = new FormData(); form.set('file', new File([await zip.arrayBuffer()], 'backup.zip'));
  const restored = await request(`${origin}/api/projects/import`, { method: 'POST', body: form });
  assert.equal(restored.status, 200, await restored.clone().text());
  const copied = await db.project.findUniqueOrThrow({ where: { id: (await restored.json()).id }, include: { chapters: { include: { sections: true } } } });
  assert.equal(copied.chapters[0].sections.length, 2);
  const pdf = await request(`${origin}/api/projects/${project.id}/export/pdf`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ size: 'trim', scope: 'section', targetId: two.id }) });
  assert.equal(pdf.status, 200, await pdf.clone().text().then(t => t.slice(0, 200)));
  const pdfCheck = JSON.parse(decodeURIComponent(pdf.headers.get('x-pdf-check')));
  assert.equal(pdfCheck.sizeOk, true); assert.equal(pdfCheck.kopubEmbedded, true);
  await fs.writeFile(path.join(dir, 'export.pdf'), Buffer.from(await pdf.arrayBuffer()));
  const hwpx = await request(`${origin}/api/projects/${project.id}/export/hwpx`, { method: 'POST' });
  assert.equal(hwpx.status, 200);
  const hwpxZip = await JSZip.loadAsync(await hwpx.arrayBuffer());
  assert.ok(hwpxZip.file('Contents/section0.xml'));
  console.log(JSON.stringify({ ok: true, web, checks: ['API validation', 'CSRF', 'autosave', 'search', 'offline retry', 'section switching', 'version history', 'reload recovery', 'preview', 'backup/import', 'PDF size/fonts', 'HWPX structure'], artifacts: dir }));
} finally {
  await browser?.close();
  server.kill();
  await db.$disconnect();
  await fs.writeFile(path.join(dir, 'server.log'), logs);
}
