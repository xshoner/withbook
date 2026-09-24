import { prisma } from "@/lib/db";
import { handle, ok } from "@/lib/api";
import { designToc } from "@/lib/ai/tasks";

export const maxDuration = 300;

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/toc/design">) => {
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
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
});
