import { z } from "zod";
import { fail, handle, ok } from "@/lib/api";
import { prisma } from "@/lib/db";
import { applyBlockChanges } from "@/lib/doc/edit";
import { editSections } from "@/lib/section-edit";

const body = z.object({
  changes: z
    .array(z.object({ sectionId: z.string(), paragraph: z.number().int().positive(), before: z.string().min(1), after: z.string() }))
    .min(1)
    .max(200),
});

/** 작가가 고른 퇴고안만 적용 — 절마다 적용 전 원고를 버전(chapter_revise)으로 남긴다 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/chapters/[id]/revise/apply">) => {
  const { id } = await ctx.params;
  const { changes } = body.parse(await req.json());
  const secs = await prisma.section.findMany({ where: { chapterId: id }, select: { id: true } });
  const inChapter = new Set(secs.map((s) => s.id));
  if (changes.some((c) => !inChapter.has(c.sectionId))) return fail("이 장에 없는 절의 수정이 들어 있습니다.");
  let applied = 0;
  let failed = 0;
  const bySection = Map.groupBy(changes, (c) => c.sectionId);
  const changed = await editSections([...bySection.keys()], "chapter_revise", (doc, sid) => {
    const r = applyBlockChanges(doc, bySection.get(sid) ?? []);
    applied += r.applied.length;
    failed += r.failed.length;
    return r.applied.length ? r.doc : null;
  });
  return ok({ applied, failed, sections: changed });
});
