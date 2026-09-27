import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import type { TocDesign } from "@/lib/ai/tasks";
import { clearExtras, clearPartials, trashChapter } from "@/lib/trash";

/** 본문이나 스케치가 있는 절 — 목차를 바꾸기 전에 확인을 받고, 그 장은 휴지통에 담는다 */
const hasWork = { OR: [{ charCount: { gt: 0 } }, { sketch: { not: "" } }] };

/**
 * 목차 보고서를 실제 장/절로 적용 (기존 목차 교체)
 * 쓴 절이 있는 기존 장은 지우기 전에 [삭제한 장·절](휴지통, 30일)에 담아 되돌릴 수 있게 한다.
 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/toc/apply">) => {
  const { id } = await ctx.params;
  const { reportId, force } = await req.json();
  const rep = await prisma.tocReport.findUnique({ where: { id: reportId } });
  if (!rep || rep.projectId !== id) return fail("보고서를 찾을 수 없습니다.", 404);
  const written = await prisma.section.count({ where: { chapter: { projectId: id }, ...hasWork } });
  if (written > 0 && !force) return ok({ needConfirm: true, written });

  const d: TocDesign = JSON.parse(rep.json);
  await prisma.$transaction(async (tx) => {
    // 쓴 절이 있는 장만 휴지통에 담는다 (빈 뼈대 장까지 담으면 목록만 어지럽다)
    const old = await tx.chapter.findMany({
      where: { projectId: id },
      orderBy: { order: "asc" },
      select: { id: true, kind: true, sections: { where: hasWork, select: { id: true }, take: 1 } },
    });
    let n = 0;
    for (const c of old) {
      if (c.kind === "body") n++;
      if (c.sections.length) await trashChapter(tx, c.id, `목차 교체 전 ${c.kind === "front" ? "앞붙이" : c.kind === "back" ? "뒷붙이" : `${n}장`}`.slice(0, 40));
    }
    const rest = await tx.section.findMany({ where: { chapter: { projectId: id } }, select: { id: true } });
    await clearPartials(tx, rest.map((s) => s.id));
    await clearExtras(tx, rest.map((s) => s.id));
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
  }, { timeout: 60_000 });
  return ok({ ok: true });
});
