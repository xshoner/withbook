import { z } from "zod";
import { fail, handle, ok } from "@/lib/api";
import { prisma } from "@/lib/db";
import { replaceAllInDoc } from "@/lib/doc/edit";
import { editSections, projectSectionIds } from "@/lib/section-edit";

const body = z.object({
  query: z.string().min(1).max(200),
  replacement: z.string().max(500),
  sectionIds: z.array(z.string()).max(2000).optional(),
});

/** 책 전체(또는 고른 절) 바꾸기 — 바꾸기 전 원고는 절마다 버전 기록(replace)에 남는다 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/replace">) => {
  const { id } = await ctx.params;
  const b = body.parse(await req.json());
  if (!(await prisma.project.findUnique({ where: { id }, select: { id: true } }))) return fail("프로젝트를 찾을 수 없습니다.", 404);
  const all = await projectSectionIds(id);
  const targets = b.sectionIds ? b.sectionIds.filter((s) => all.includes(s)) : all;
  let count = 0;
  const changed = await editSections(targets, "replace", (doc) => {
    const r = replaceAllInDoc(doc, b.query, b.replacement);
    count += r.count;
    return r.count ? r.doc : null;
  });
  return ok({ count, sections: changed });
});
