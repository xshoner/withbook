import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";

/**
 * 목차 편집 — op 단위로 즉시 저장
 * addChapter {title, kind?} | addSection {chapterId, title, afterId?} | renameChapter {chapterId, title}
 * renameSection {sectionId, title} | updateSection {sectionId, gist?, targetPages?} | deleteChapter {chapterId}
 * deleteSection {sectionId} | reorderChapters {ids} | reorderSections {chapterId, ids} | moveSection {sectionId, toChapterId}
 */
export const PATCH = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/toc">) => {
  const { id: projectId } = await ctx.params;
  const b = await req.json();
  const ownsChapter = async (chapterId: string) => {
    const c = await prisma.chapter.findUnique({ where: { id: chapterId } });
    if (!c || c.projectId !== projectId) throw Object.assign(new Error("장을 찾을 수 없습니다."), { status: 404 });
    return c;
  };
  const ownsSection = async (sectionId: string) => {
    const s = await prisma.section.findUnique({ where: { id: sectionId }, include: { chapter: true } });
    if (!s || s.chapter.projectId !== projectId) throw Object.assign(new Error("절을 찾을 수 없습니다."), { status: 404 });
    return s;
  };

  switch (b.op) {
    case "addChapter": {
      const kind = ["front", "body", "back"].includes(b.kind) ? b.kind : "body";
      const max = await prisma.chapter.aggregate({ where: { projectId }, _max: { order: true } });
      const c = await prisma.chapter.create({
        data: {
          projectId,
          kind,
          order: (max._max.order ?? 0) + 1,
          title: b.title?.trim() || (kind === "body" ? "새 장" : kind === "front" ? "머리말" : "맺음말"),
          sections: { create: [{ order: 1, title: kind === "body" ? "새 절" : b.title?.trim() || "본문" }] },
        },
      });
      return ok({ id: c.id });
    }
    case "addSection": {
      await ownsChapter(b.chapterId);
      const secs = await prisma.section.findMany({ where: { chapterId: b.chapterId }, orderBy: { order: "asc" } });
      let order = secs.length + 1;
      if (b.afterId) {
        const i = secs.findIndex((s) => s.id === b.afterId);
        if (i >= 0) {
          order = i + 2;
          await prisma.$transaction(
            secs.slice(i + 1).map((s, k) => prisma.section.update({ where: { id: s.id }, data: { order: order + 1 + k } })),
          );
        }
      }
      const s = await prisma.section.create({ data: { chapterId: b.chapterId, order, title: b.title?.trim() || "새 절" } });
      return ok({ id: s.id });
    }
    case "renameChapter":
      await ownsChapter(b.chapterId);
      await prisma.chapter.update({ where: { id: b.chapterId }, data: { title: String(b.title ?? "").trim() || "제목 없음" } });
      return ok({ ok: true });
    case "renameSection":
      await ownsSection(b.sectionId);
      await prisma.section.update({ where: { id: b.sectionId }, data: { title: String(b.title ?? "").trim() || "제목 없음" } });
      return ok({ ok: true });
    case "updateSection": {
      await ownsSection(b.sectionId);
      const data: Record<string, unknown> = {};
      if (typeof b.gist === "string") data.gist = b.gist;
      if (b.targetPages !== undefined) data.targetPages = Math.max(0.5, Math.min(60, Number(b.targetPages) || 3));
      await prisma.section.update({ where: { id: b.sectionId }, data });
      return ok({ ok: true });
    }
    case "deleteChapter":
      await ownsChapter(b.chapterId);
      await prisma.chapter.delete({ where: { id: b.chapterId } });
      return ok({ ok: true });
    case "deleteSection": {
      const s = await ownsSection(b.sectionId);
      const count = await prisma.section.count({ where: { chapterId: s.chapterId } });
      if (count <= 1) return fail("장에는 절이 최소 1개 있어야 합니다. 장을 삭제하세요.");
      await prisma.section.delete({ where: { id: b.sectionId } });
      const rest = await prisma.section.findMany({ where: { chapterId: s.chapterId }, orderBy: { order: "asc" } });
      await prisma.$transaction(rest.map((r, i) => prisma.section.update({ where: { id: r.id }, data: { order: i + 1 } })));
      return ok({ ok: true });
    }
    case "reorderChapters": {
      const ids: string[] = b.ids ?? [];
      for (const cid of ids) await ownsChapter(cid);
      await prisma.$transaction(ids.map((cid, i) => prisma.chapter.update({ where: { id: cid }, data: { order: i + 1 } })));
      return ok({ ok: true });
    }
    case "reorderSections": {
      await ownsChapter(b.chapterId);
      const ids: string[] = b.ids ?? [];
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length) return fail("절 순서가 올바르지 않습니다.");
      const sections = await prisma.section.findMany({ where: { chapterId: b.chapterId }, select: { id: true } });
      if (sections.length !== ids.length || sections.some((s) => !ids.includes(s.id))) return fail("해당 장의 모든 절을 한 번씩 지정하세요.");
      await prisma.$transaction(
        ids.map((sid, i) => prisma.section.update({ where: { id: sid }, data: { order: i + 1, chapterId: b.chapterId } })),
      );
      return ok({ ok: true });
    }
    case "moveSection": {
      const s = await ownsSection(b.sectionId);
      await ownsChapter(b.toChapterId);
      const count = await prisma.section.count({ where: { chapterId: s.chapterId } });
      if (count <= 1) return fail("장의 마지막 절은 옮길 수 없습니다.");
      const max = await prisma.section.aggregate({ where: { chapterId: b.toChapterId }, _max: { order: true } });
      await prisma.section.update({ where: { id: b.sectionId }, data: { chapterId: b.toChapterId, order: (max._max.order ?? 0) + 1 } });
      const rest = await prisma.section.findMany({ where: { chapterId: s.chapterId }, orderBy: { order: "asc" } });
      await prisma.$transaction(rest.map((r, i) => prisma.section.update({ where: { id: r.id }, data: { order: i + 1 } })));
      return ok({ ok: true });
    }
  }
  return fail("알 수 없는 작업입니다.");
});
