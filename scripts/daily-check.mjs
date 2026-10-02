// 매일 아침 운영 점검 — .github/workflows/daily-check.yml이 /api/health?report=1 응답을 넘긴다.
// 서버가 응답하지 않거나(DB·저장소 이상 포함) 어제 서버 오류가 있었으면 이슈 본문(report.md)을 쓰고 problem=true를 낸다.
// 저장소가 공개라 이슈에 그대로 보인다 — 서버도 원래 오류 문구는 보내지 않는다(경로·종류·건수·화면 안내만).
// 사용: node scripts/daily-check.mjs <응답 파일> <HTTP 상태>
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const [file, code] = process.argv.slice(2);
const status = Number(code) || 0;
let body = null;
try {
  body = JSON.parse(readFileSync(file, 'utf8'));
} catch {}

const lines = [];
let problem = false;
if (!body || status === 0) {
  problem = true;
  lines.push(`### ❌ 서버가 응답하지 않습니다 (HTTP ${status || '연결 실패'})`, '', 'Vercel 배포 상태와 Supabase 상태를 확인하세요.');
} else {
  if (status === 401) {
    problem = true;
    lines.push('### ⚠️ 오류 일지를 읽지 못했습니다', '', 'HEALTH_TOKEN이 Vercel 환경 변수와 GitHub Secrets에서 서로 다르거나 Vercel에 없습니다(16자 이상).');
  } else if (!body.ok) {
    problem = true;
    lines.push(`### ❌ 상태 이상 — DB ${body.db ? '정상' : '실패'} · 저장소 ${body.storage ? '정상' : '실패'}`, '');
  }
  const days = Object.entries(body.errors ?? {});
  const [yesterday, y] = days[0] ?? [];
  if (y?.total > 0) {
    problem = true;
    lines.push(`### ⚠️ ${yesterday} 서버 오류 ${y.total}건`, '', '| 건수 | 경로 | 종류 | 화면 안내 |', '|---:|---|---|---|');
    for (const g of [...y.groups].sort((a, b) => b.n - a.n)) {
      const cell = (s) => String(s ?? '').replace(/[|\n]/g, ' ').slice(0, 120);
      lines.push(`| ${g.n} | \`${cell(g.route)}\` | ${cell(g.kind)} | ${cell(g.msg)} |`);
    }
    const shown = y.groups.reduce((a, g) => a + g.n, 0);
    if (shown < y.total) lines.push('', `(종류가 많아 ${y.total - shown}건은 합계에만 들어 있습니다)`);
    lines.push('', '자세한 내용: Vercel → withbook → Logs (해당 날짜, 경로로 거르기).');
  }
  const [today, t] = days[1] ?? [];
  if (problem && t?.total > 0) lines.push('', `오늘(${today}) 지금까지: ${t.total}건`);
}

writeFileSync('report.md', lines.join('\n') + '\n');
console.log(problem ? lines.join('\n') : `정상 — ${JSON.stringify({ ok: body?.ok, errors: Object.fromEntries(Object.entries(body?.errors ?? {}).map(([d, v]) => [d, v.total])) })}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `problem=${problem}\n`);
