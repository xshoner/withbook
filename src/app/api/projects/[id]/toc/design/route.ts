import { prisma } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { designToc } from "@/lib/ai/tasks";

export const maxDuration = 300;

/**
 * 설계 중 표시 — AppSetting `toc-design:{책 id}` = { startedAt, label }. 끝나거나 실패하면 지운다.
 * 화면을 떠났다 돌아와도(?auto=1 포함) 같은 설계를 또 시작하지 않고 결과를 기다리게 한다.
 * 서버가 도중에 끊겨 지우지 못한 표시는 6분이 지나면 없는 것으로 본다.
 */
const STALE_MS = 6 * 60_000;
const key = (id: string) => `toc-design:${id}`;
type Running = { startedAt: string; label: string };

async function running(id: string): Promise<Running | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: key(id) } });
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as Running;
    if (Date.now() - Date.parse(v.startedAt) < STALE_MS) return v;
  } catch {}
  return null;
}

/** 설계 시작 표시를 차지한다 — 이미 다른 요청이 설계 중이면 그 표시를 돌려준다 */
async function claim(id: string, label: string): Promise<Running | null> {
  const value = JSON.stringify({ startedAt: new Date().toISOString(), label } satisfies Running);
  try {
    await prisma.appSetting.create({ data: { key: key(id), value } });
    return null;
  } catch (e: any) {
    if (e?.code !== "P2002") throw e;
  }
  const cur = await running(id);
  if (cur) return cur;
  // 오래된 표시는 넘겨받는다
  await prisma.appSetting.upsert({ where: { key: key(id) }, create: { key: key(id), value }, update: { value } });
  return null;
}

/** 설계 중인지: { running: { startedAt, label } | null } */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/toc/design">) => {
  const { id } = await ctx.params;
  return ok({ running: await running(id) });
});

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/toc/design">) => {
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
  const label = typeof b.chapterIndex === "number" ? `${b.chapterIndex}장 다시 설계 중` : b.regenerate ? "다른 구성으로 설계 중" : "목차 설계 중";
  const busy = await claim(id, label);
  if (busy) return ok({ running: busy });
  try {
    let previousConcept: string | undefined;
    if (b.regenerate) {
      const last = await prisma.tocReport.findFirst({ where: { projectId: id }, orderBy: { createdAt: "desc" } });
      if (last) previousConcept = JSON.parse(last.json).concept;
    }
    const r = await designToc(id, {
      regenerate: Boolean(b.regenerate),
      chapterIndex: typeof b.chapterIndex === "number" ? b.chapterIndex : undefined,
      previousConcept,
    });
    if (!r.design) return ok({ error: r.error, raw: r.raw });
    if (typeof b.chapterIndex === "number") {
      // 부분 재설계: 기존 보고서 사본에서 해당 장만 교체해 새 안으로 저장
      const base = b.baseReportId
        ? await prisma.tocReport.findUnique({ where: { id: b.baseReportId } })
        : await prisma.tocReport.findFirst({ where: { projectId: id }, orderBy: { createdAt: "desc" } });
      if (base) {
        const j = JSON.parse(base.json);
        const idx = b.chapterIndex - 1;
        if (j.chapters[idx] && r.design.chapters[0]) j.chapters[idx] = r.design.chapters[0];
        const rep = await prisma.tocReport.create({ data: { projectId: id, json: JSON.stringify(j) } });
        return ok({ report: { id: rep.id, createdAt: rep.createdAt, ...j } });
      }
    }
    const rep = await prisma.tocReport.create({ data: { projectId: id, json: JSON.stringify(r.design) } });
    return ok({ report: { id: rep.id, createdAt: rep.createdAt, ...r.design } });
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: key(id) } }).catch((e) => console.warn("[toc-design] 설계 중 표시를 지우지 못함", e?.message));
  }
});
