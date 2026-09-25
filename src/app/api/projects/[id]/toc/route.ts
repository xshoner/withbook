import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { listTrash, restoreTrash, trashChapter, trashSection } from "@/lib/trash";

/** 순서 번호를 1부터 다시 매긴다 (같은 트랜잭션 안에서) */
async function renumberSections(tx: Prisma.TransactionClient, chapterId: string) {
  const rest = await tx.section.findMany({ where: { chapterId }, orderBy: { order: "asc" }, select: { id: true, order: true } });
  for (const [i, r] of rest.entries()) if (r.order !== i + 1) await tx.section.update({ where: { id: r.id }, data: { order: i + 1 } });
}
async function renumberChapters(tx: Prisma.TransactionClient, projectId: string) {
  const rest = await tx.chapter.findMany({ where: { projectId }, orderBy: { order: "asc" }, select: { id: true, order: true } });
  for (const [i, r] of rest.entries()) if (r.order !== i + 1) await tx.chapter.update({ where: { id: r.id }, data: { order: i + 1 } });
}
const TX = { timeout: 20_000 };
const labelOf = (v: unknown) => (typeof v === "string" ? v.slice(0, 40) : "");

/** 휴지통 목록: GET ?trash=1 → { items: [{ id, kind, title, label, deletedAt, charCount, versionsDropped? }] } */
export const GET = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/toc">) => {
  const { id: projectId } = await ctx.params;
  if (new URL(req.url).searchParams.get("trash") !== "1") return fail("알 수 없는 요청입니다.");
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!p) return fail("책을 찾을 수 없습니다.", 404);
  return ok({ items: await listTrash(projectId) });
});

/**
 * 목차 편집 — op 단위로 즉시 저장
 * addChapter {title, kind?} | addSection {chapterId, title, afterId?} | renameChapter {chapterId, title}
 * renameSection {sectionId, title} | updateSection {sectionId, gist?, targetPages?} | deleteChapter {chapterId}
 * deleteSection {sectionId} | reorderChapters {ids} | reorderSections {chapterId, ids} | moveSection {sectionId, toChapterId}
 * restoreTrash {trashId} | refresh (아무것도 하지 않음 — 목록 다시 읽기용)
 * 삭제는 휴지통(AppSetting)에 먼저 담고 { ok, trashId }를 돌려준다. label?: 목차 번호(휴지통 표시용)
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
      const c = await prisma.$transaction(async (tx) => {
        const max = await tx.chapter.aggregate({ where: { projectId }, _max: { order: true } });
        return tx.chapter.create({
          data: {
            projectId,
            kind,
            order: (max._max.order ?? 0) + 1,
            title: b.title?.trim() || (kind === "body" ? "새 장" : kind === "front" ? "머리말" : "맺음말"),
            sections: { create: [{ order: 1, title: kind === "body" ? "새 절" : b.title?.trim() || "본문" }] },
          },
        });
      }, TX);
      return ok({ id: c.id });
    }
    case "addSection": {
      await ownsChapter(b.chapterId);
      const s = await prisma.$transaction(async (tx) => {
        const secs = await tx.section.findMany({ where: { chapterId: b.chapterId }, orderBy: { order: "asc" }, select: { id: true } });
        let order = secs.length + 1;
        const i = b.afterId ? secs.findIndex((s) => s.id === b.afterId) : -1;
        if (i >= 0) {
          order = i + 2;
          for (const [k, sec] of secs.slice(i + 1).entries()) await tx.section.update({ where: { id: sec.id }, data: { order: order + 1 + k } });
        }
        return tx.section.create({ data: { chapterId: b.chapterId, order, title: b.title?.trim() || "새 절" } });
      }, TX);
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
    case "deleteChapter": {
      await ownsChapter(b.chapterId);
      const trashId = await prisma.$transaction(async (tx) => {
        const tid = await trashChapter(tx, b.chapterId, labelOf(b.label));
        await tx.chapter.delete({ where: { id: b.chapterId } });
        await renumberChapters(tx, projectId);
        return tid;
      }, TX);
      return ok({ ok: true, trashId });
    }
    case "deleteSection": {
      const s = await ownsSection(b.sectionId);
      const done = await prisma.$transaction(async (tx) => {
        const count = await tx.section.count({ where: { chapterId: s.chapterId } });
        if (count <= 1) return null;
        const tid = await trashSection(tx, b.sectionId, labelOf(b.label));
        await tx.section.delete({ where: { id: b.sectionId } });
        await renumberSections(tx, s.chapterId);
        return tid;
      }, TX);
      if (!done) return fail("장에는 절이 최소 1개 있어야 합니다. 장을 삭제하세요.");
      return ok({ ok: true, trashId: done });
    }
    case "reorderChapters": {
      const ids: string[] = b.ids ?? [];
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length) return fail("장 순서가 올바르지 않습니다.");
      // 모두 이 프로젝트의 장인지 한 번에 확인
      const owned = await prisma.chapter.count({ where: { id: { in: ids }, projectId } });
      if (owned !== ids.length) return fail("장을 찾을 수 없습니다.", 404);
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
      const done = await prisma.$transaction(async (tx) => {
        const count = await tx.section.count({ where: { chapterId: s.chapterId } });
        if (count <= 1) return false;
        const max = await tx.section.aggregate({ where: { chapterId: b.toChapterId }, _max: { order: true } });
        await tx.section.update({ where: { id: b.sectionId }, data: { chapterId: b.toChapterId, order: (max._max.order ?? 0) + 1 } });
        await renumberSections(tx, s.chapterId);
        return true;
      }, TX);
      if (!done) return fail("장의 마지막 절은 옮길 수 없습니다.");
      return ok({ ok: true });
    }
    case "restoreTrash": {
      if (typeof b.trashId !== "string" || !b.trashId) return fail("되돌릴 항목을 지정하세요.");
      const r = await restoreTrash(projectId, b.trashId);
      return ok({ ok: true, ...r });
    }
    case "refresh":
      return ok({ ok: true });
  }
  return fail("알 수 없는 작업입니다.");
});
