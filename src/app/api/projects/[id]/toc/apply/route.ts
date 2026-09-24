import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import type { TocDesign } from "@/lib/ai/tasks";

/** 목차 보고서를 실제 장/절로 적용 (기존 목차 교체) */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/toc/apply">) => {
  const { id } = await ctx.params;
  const { reportId, force } = await req.json();
  const rep = await prisma.tocReport.findUnique({ where: { id: reportId } });
  if (!rep || rep.projectId !== id) return fail("보고서를 찾을 수 없습니다.", 404);
  const written = await prisma.section.count({ where: { chapter: { projectId: id }, charCount: { gt: 0 } } });
  if (written > 0 && !force) return ok({ needConfirm: true, written });

  const d: TocDesign = JSON.parse(rep.json);
  await prisma.$transaction(async (tx) => {
    await tx.chapter.deleteMany({ where: { projectId: id } });
    let order = 0;
    for (const t of d.frontMatter ?? []) {
      await tx.chapter.create({
        data: { projectId: id, kind: "front", order: ++order, title: t, sections: { create: [{ order: 1, title: t, targetPages: 2 }] } },
      });
    }
    for (const c of d.chapters) {
      await tx.chapter.create({
        data: {
          projectId: id,
          kind: "body",
          order: ++order,
          title: c.title,
          promise: c.promise ?? "",
          sections: {
            create: c.sections.map((s, i) => ({
              order: i + 1,
              title: s.title,
              gist: s.gist ?? "",
              hook: s.hook ?? "",
              targetPages: Number(s.targetPages) || 3,
            })),
          },
        },
      });
    }
    for (const t of d.backMatter ?? []) {
      await tx.chapter.create({
        data: { projectId: id, kind: "back", order: ++order, title: t, sections: { create: [{ order: 1, title: t, targetPages: 2 }] } },
      });
    }
  });
  return ok({ ok: true });
});
