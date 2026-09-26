import { z } from "zod";
import { fail, handle, ok } from "@/lib/api";
import { flatSections, loadBook } from "@/lib/book";
import { prisma } from "@/lib/db";
import { parseDoc } from "@/lib/doc/doc";
import { findMarkers, resolveMarker } from "@/lib/doc/edit";
import { editSections } from "@/lib/section-edit";

/** 책 전체(sectionId를 주면 그 절)에 남은 [확인 필요]·[이미지 제안] 표시 목록 */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/checks">) => {
  const { id } = await ctx.params;
  const only = new URL(req.url).searchParams.get("sectionId");
  const book = await loadBook(id);
  if (!book) return fail("프로젝트를 찾을 수 없습니다.", 404);
  const sections = flatSections(book)
    .filter(({ section }) => !only || section.id === only)
    .map(({ chapter, section }) => ({
      sectionId: section.id,
      label: section.label,
      title: section.title,
      chapterTitle: chapter.title,
      markers: findMarkers(parseDoc(section.content)),
    }))
    .filter((s) => s.markers.length);
  return ok({ total: sections.reduce((a, s) => a + s.markers.length, 0), sections });
});

const body = z.object({
  sectionId: z.string(),
  paragraph: z.number().int().positive(),
  offset: z.number().int(),
  footnote: z.number().int().nonnegative().optional(),
  marker: z.string().min(3).max(320),
  action: z.enum(["remove", "footnote"]),
  note: z.string().max(600).optional(),
});

/** 표시 처리 — remove(확인함, 표시 지우기) | footnote(출처·설명을 각주로 달고 표시 지우기) */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/checks">) => {
  const { id } = await ctx.params;
  const b = body.parse(await req.json());
  if (b.action === "footnote" && !b.note?.trim()) return fail("각주로 달 출처나 설명을 입력하세요.");
  const sec = await prisma.section.findFirst({ where: { id: b.sectionId, chapter: { projectId: id } }, select: { id: true } });
  if (!sec) return fail("절을 찾을 수 없습니다.", 404);
  const changed = await editSections([sec.id], "check", (doc) => resolveMarker(doc, b, b.action, b.note));
  if (!changed.length) return fail("원고가 그사이 바뀌어 이 표시를 찾지 못했습니다. 목록을 새로 고치세요.", 409);
  return ok({ ok: true });
});
