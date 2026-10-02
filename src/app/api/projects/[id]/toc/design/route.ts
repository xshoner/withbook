import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { designTocChapter, designTocSkeleton } from "@/lib/ai/tasks";
import { applyChapterDetail, pendingChapters, replaceChapter, type TocChapter, type TocReportJson } from "@/lib/ai/toc-steps";

export const maxDuration = 300;

/**
 * 목차 설계 — 서버 시간 한도(Vercel Hobby 300초) 안에 끝나도록 요청 여러 개로 나눈다(toc-steps.ts).
 *   { step: "skeleton", runId, regenerate? } → 골격을 만들어 보고서로 저장 (detailPending: 세부가 남은 장)
 *   { step: "detail", runId, reportId, chapterIndex } → 그 장의 세부를 채워 보고서에 합친다 (브라우저가 2~3개씩 동시에)
 *   { step: "finish", runId } → 설계 중 표시를 지운다
 *   { chapterIndex, baseReportId } → [이 장만 다시] (요청 하나, 출력이 작다)
 *
 * 설계 중 표시 — AppSetting `toc-design:{책 id}` = { startedAt, label, runId }.
 * 한 번의 설계(runId)가 골격부터 마지막 장까지 표시를 쥐고, 요청마다 startedAt을 새로 해 살아 있음을 알린다.
 * 화면을 떠났다 돌아와도(?auto=1 포함) 다른 탭은 새로 시작하지 않고 결과를 기다린다.
 * 브라우저가 끊겨 지우지 못한 표시는 마지막 요청 후 6분이 지나면 없는 것으로 본다(남은 장은 화면을 다시 열면 이어서 채운다).
 */
const STALE_MS = 6 * 60_000;
const key = (id: string) => `toc-design:${id}`;
type Running = { startedAt: string; label: string; runId?: string };

async function running(id: string): Promise<Running | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: key(id) } });
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as Running;
    if (Date.now() - Date.parse(v.startedAt) < STALE_MS) return v;
  } catch {}
  return null;
}

/** 설계 중 표시를 차지한다 — 다른 설계(runId가 다름)가 진행 중이면 그 표시를 돌려준다. 같은 runId면 표시를 새로 한다 */
async function hold(id: string, label: string, runId?: string): Promise<Running | null> {
  const value = JSON.stringify({ startedAt: new Date().toISOString(), label, runId } satisfies Running);
  try {
    await prisma.appSetting.create({ data: { key: key(id), value } });
    return null;
  } catch (e: any) {
    if (e?.code !== "P2002") throw e;
  }
  const cur = await running(id);
  if (cur && (!runId || cur.runId !== runId)) return cur;
  // 오래된 표시는 넘겨받고, 같은 설계의 표시는 시각을 새로 한다
  await prisma.appSetting.upsert({ where: { key: key(id) }, create: { key: key(id), value }, update: { value } });
  return null;
}

/** 설계 중 표시를 지운다 — runId를 주면 그 설계의 표시일 때만 */
async function release(id: string, runId?: string) {
  try {
    if (runId) {
      const row = await prisma.appSetting.findUnique({ where: { key: key(id) } });
      if (!row) return;
      let cur: Running | null = null;
      try {
        cur = JSON.parse(row.value);
      } catch {}
      if (cur?.runId && cur.runId !== runId) return;
      await prisma.appSetting.deleteMany({ where: { key: key(id), value: row.value } });
    } else await prisma.appSetting.deleteMany({ where: { key: key(id) } });
  } catch (e: any) {
    console.warn("[toc-design] 설계 중 표시를 지우지 못함", e?.message);
  }
}

const runIdOf = (v: unknown) => (typeof v === "string" && /^[\w-]{6,64}$/.test(v) ? v : undefined);
const chapterNoOf = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 200 ? v : undefined);
const reportOut = (rep: { id: string; createdAt: Date }, j: TocReportJson) => ({ id: rep.id, createdAt: rep.createdAt, ...j });

/**
 * 보고서 하나를 고쳐 저장한다 — 장별 세부 요청이 동시에 와도 서로 덮어쓰지 않게, 읽은 내용 그대로일 때만 쓰고 아니면 다시 읽어 합친다.
 */
async function updateReport(reportId: string, projectId: string, change: (j: TocReportJson) => TocReportJson) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const rep = await prisma.tocReport.findUnique({ where: { id: reportId } });
    if (!rep || rep.projectId !== projectId) return null;
    const next = change(JSON.parse(rep.json));
    const json = JSON.stringify(next);
    const r = await prisma.tocReport.updateMany({ where: { id: reportId, json: rep.json }, data: { json } });
    if (r.count) return { rep, json: next };
  }
  throw new Error("목차 보고서를 저장하지 못했습니다. 다시 시도하세요.");
}

/** 설계 중인지: { running: { startedAt, label } | null } */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/toc/design">) => {
  const { id } = await ctx.params;
  const r = await running(id);
  return ok({ running: r ? { startedAt: r.startedAt, label: r.label } : null });
});

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/toc/design">) => {
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
  const runId = runIdOf(b.runId);

  if (b.step === "finish") {
    await release(id, runId);
    return ok({ released: true });
  }

  if (b.step === "detail") {
    const chapterNo = chapterNoOf(b.chapterIndex);
    if (!runId || !chapterNo || typeof b.reportId !== "string") return fail("요청 형식이 올바르지 않습니다.", 400);
    const base = await prisma.tocReport.findUnique({ where: { id: b.reportId } });
    if (!base || base.projectId !== id) return fail("보고서를 찾을 수 없습니다.", 404);
    const skeleton: TocReportJson = JSON.parse(base.json);
    if (!skeleton.chapters[chapterNo - 1]) return fail("그 장이 없습니다.", 400);
    // 이미 채운 장(다른 탭·이전 요청) — 다시 부르지 않는다
    if (!pendingChapters(skeleton).includes(chapterNo)) return ok({ chapter: skeleton.chapters[chapterNo - 1], detailPending: pendingChapters(skeleton) });
    const busy = await hold(id, "목차 세부 설계 중", runId);
    if (busy) return ok({ running: { startedAt: busy.startedAt, label: busy.label } });
    const r = await designTocChapter(id, { chapterIndex: chapterNo, mode: "detail", report: skeleton });
    if (!r.chapter) return ok({ error: r.error, raw: r.raw });
    const saved = await updateReport(base.id, id, (j) => applyChapterDetail(j, chapterNo, r.chapter as TocChapter));
    if (!saved) return fail("보고서를 찾을 수 없습니다.", 404);
    return ok({ chapter: saved.json.chapters[chapterNo - 1], detailPending: pendingChapters(saved.json) });
  }

  const chapterNo = chapterNoOf(b.chapterIndex);
  const label = chapterNo ? `${chapterNo}장 다시 설계 중` : b.regenerate ? "다른 구성으로 설계 중" : "목차 설계 중";
  const busy = await hold(id, label, runId);
  if (busy) return ok({ running: { startedAt: busy.startedAt, label: busy.label } });
  // 골격 단계(step: "skeleton")는 표시를 쥔 채 끝난다 — 장별 세부까지 마친 브라우저가 finish로 지운다
  let keep = b.step === "skeleton" && Boolean(runId);
  try {
    if (chapterNo) {
      // 부분 재설계: 기존 보고서 사본에서 해당 장만 교체해 새 안으로 저장
      const base = b.baseReportId
        ? await prisma.tocReport.findUnique({ where: { id: b.baseReportId } })
        : await prisma.tocReport.findFirst({ where: { projectId: id }, orderBy: { createdAt: "desc" } });
      const j: TocReportJson | null = base && base.projectId === id ? JSON.parse(base.json) : null;
      if (!j || !j.chapters[chapterNo - 1]) return ok({ error: "다시 설계할 장이 보고서에 없습니다." });
      const r = await designTocChapter(id, { chapterIndex: chapterNo, mode: "redesign", report: j });
      if (!r.chapter) return ok({ error: r.error, raw: r.raw });
      const next = replaceChapter(j, chapterNo, r.chapter);
      const rep = await prisma.tocReport.create({ data: { projectId: id, json: JSON.stringify(next) } });
      return ok({ report: reportOut(rep, next) });
    }
    let previousConcept: string | undefined;
    if (b.regenerate) {
      const last = await prisma.tocReport.findFirst({ where: { projectId: id }, orderBy: { createdAt: "desc" } });
      if (last) previousConcept = JSON.parse(last.json).concept;
    }
    const r = await designTocSkeleton(id, { regenerate: Boolean(b.regenerate), previousConcept });
    if (!r.design) {
      keep = false;
      return ok({ error: r.error, raw: r.raw });
    }
    const rep = await prisma.tocReport.create({ data: { projectId: id, json: JSON.stringify(r.design) } });
    return ok({ report: reportOut(rep, r.design) });
  } catch (e) {
    keep = false;
    throw e;
  } finally {
    if (!keep) await release(id, runId);
  }
});
