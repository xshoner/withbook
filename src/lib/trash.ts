import type { Prisma } from "@prisma/client";

/**
 * 장·절 휴지통 — 스키마를 바꾸지 않고 AppSetting에 JSON으로 보관한다.
 *   key: trash:{projectId}:{trashId}   (trashId = 지운 장·절의 id, 되돌리면 같은 id로 다시 만든다)
 *   30일이 지나면 dailyMaintenance가 지운다.
 * 순수 함수(스냅숏 만들기·끼울 자리 계산)는 DB 없이 테스트한다.
 */

export const TRASH_PREFIX = "trash:";
export const TRASH_KEEP_DAYS = 30;
/** 이보다 크면 버전 기록은 빼고 본문만 보관 */
export const TRASH_MAX_BYTES = 20 * 1024 * 1024;

type Kind = "front" | "body" | "back";
type VersionSnap = { id: string; reason: string; content: string; charCount: number; createdAt: string };
export type SectionSnap = {
  id: string;
  title: string;
  gist: string;
  hook: string;
  targetPages: number;
  status: string;
  sketch: string;
  content: string;
  charCount: number;
  summary: string | null;
  summaryHash: string | null;
  updatedAt: string;
  versions: VersionSnap[];
};
export type ChapterSnap = { id: string; title: string; kind: string; promise: string; summary: string | null; summaryHash: string | null; sections: SectionSnap[] };

export type TrashMeta = { id: string; kind: "section" | "chapter"; title: string; label: string; deletedAt: string; charCount: number; versionsDropped?: boolean };
export type TrashEntry = {
  meta: TrashMeta;
  projectId: string;
  /** 절: 원래 장 id와 장 안 위치(0부터) */
  chapterId?: string;
  index: number;
  /** 장: 같은 종류(front/body/back) 안 위치(0부터) */
  chapterKind?: Kind;
  section?: SectionSnap;
  chapter?: ChapterSnap;
};

export const trashKey = (projectId: string, trashId: string) => `${TRASH_PREFIX}${projectId}:${trashId}`;

const err = (message: string, status = 400) => Object.assign(new Error(message), { status });

type SectionRow = Omit<SectionSnap, "updatedAt" | "versions"> & { updatedAt: Date | string; versions?: { id: string; reason: string; content: string; charCount: number; createdAt: Date | string }[] };

export function snapSection(s: SectionRow): SectionSnap {
  return {
    id: s.id,
    title: s.title,
    gist: s.gist,
    hook: s.hook,
    targetPages: s.targetPages,
    status: s.status,
    sketch: s.sketch,
    content: s.content,
    charCount: s.charCount,
    summary: s.summary,
    summaryHash: s.summaryHash,
    updatedAt: new Date(s.updatedAt).toISOString(),
    versions: (s.versions ?? []).map((v) => ({ id: v.id, reason: v.reason, content: v.content, charCount: v.charCount, createdAt: new Date(v.createdAt).toISOString() })),
  };
}

/** JSON으로 굳힌다. 너무 크면 버전 기록을 빼고 표시해 둔다 */
export function serializeEntry(e: TrashEntry, max = TRASH_MAX_BYTES): string {
  let json = JSON.stringify(e);
  if (Buffer.byteLength(json, "utf8") <= max) return json;
  const strip = (s: SectionSnap): SectionSnap => ({ ...s, versions: [] });
  const lean: TrashEntry = {
    ...e,
    meta: { ...e.meta, versionsDropped: true },
    section: e.section && strip(e.section),
    chapter: e.chapter && { ...e.chapter, sections: e.chapter.sections.map(strip) },
  };
  json = JSON.stringify(lean);
  return json;
}

/** ids 목록에서 새 항목을 끼울 자리(0부터) — 원래 위치를 넘으면 끝 */
export function insertIndex(length: number, index: number) {
  return Math.max(0, Math.min(length, Math.floor(index) || 0));
}

/**
 * 장을 되돌릴 자리: 같은 종류 안 원래 위치. 같은 종류가 없으면 앞붙이 → 본문 → 뒷붙이 순서를 지킨다.
 * chapters는 전체 순서대로. 반환값은 전체 목록 안 위치(0부터)
 */
export function chapterInsertIndex(chapters: { kind: string }[], kind: Kind, kindIndex: number) {
  const rank = (k: string) => (k === "front" ? 0 : k === "back" ? 2 : 1);
  const same = chapters.map((c, i) => ({ c, i })).filter((x) => x.c.kind === kind);
  if (same.length) {
    const k = insertIndex(same.length, kindIndex);
    return k < same.length ? same[k].i : same[same.length - 1].i + 1;
  }
  const after = chapters.findIndex((c) => rank(c.kind) > rank(kind));
  return after < 0 ? chapters.length : after;
}

/* ───────── DB ───────── */

const db = async () => (await import("./db")).prisma;

async function sectionRow(tx: Prisma.TransactionClient, sectionId: string) {
  return tx.section.findUnique({ where: { id: sectionId }, include: { versions: true, chapter: { select: { projectId: true } } } });
}

/** 절을 지우기 직전에 휴지통에 담는다 (같은 트랜잭션 안에서). trashId 반환 */
export async function trashSection(tx: Prisma.TransactionClient, sectionId: string, label = "") {
  const s = await sectionRow(tx, sectionId);
  if (!s) throw err("절을 찾을 수 없습니다.", 404);
  const siblings = await tx.section.findMany({ where: { chapterId: s.chapterId }, orderBy: { order: "asc" }, select: { id: true } });
  const entry: TrashEntry = {
    meta: { id: s.id, kind: "section", title: s.title, label, deletedAt: new Date().toISOString(), charCount: s.charCount },
    projectId: s.chapter.projectId,
    chapterId: s.chapterId,
    index: Math.max(0, siblings.findIndex((x) => x.id === s.id)),
    section: snapSection(s),
  };
  const key = trashKey(s.chapter.projectId, s.id);
  const value = serializeEntry(entry);
  await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  return s.id;
}

/** 장(과 그 안의 모든 절)을 지우기 직전에 휴지통에 담는다. trashId 반환 */
export async function trashChapter(tx: Prisma.TransactionClient, chapterId: string, label = "") {
  const c = await tx.chapter.findUnique({ where: { id: chapterId }, include: { sections: { orderBy: { order: "asc" }, include: { versions: true } } } });
  if (!c) throw err("장을 찾을 수 없습니다.", 404);
  const all = await tx.chapter.findMany({ where: { projectId: c.projectId }, orderBy: { order: "asc" }, select: { id: true, kind: true } });
  const kind = (["front", "body", "back"].includes(c.kind) ? c.kind : "body") as Kind;
  const entry: TrashEntry = {
    meta: { id: c.id, kind: "chapter", title: c.title, label, deletedAt: new Date().toISOString(), charCount: c.sections.reduce((a, s) => a + s.charCount, 0) },
    projectId: c.projectId,
    chapterKind: kind,
    index: Math.max(0, all.filter((x) => x.kind === c.kind).findIndex((x) => x.id === c.id)),
    chapter: { id: c.id, title: c.title, kind, promise: c.promise, summary: c.summary, summaryHash: c.summaryHash, sections: c.sections.map(snapSection) },
  };
  const key = trashKey(c.projectId, c.id);
  const value = serializeEntry(entry);
  await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  return c.id;
}

/** 휴지통 목록 (최신순, 본문 없이) */
export async function listTrash(projectId: string): Promise<TrashMeta[]> {
  const prisma = await db();
  const prefix = trashKey(projectId, "");
  // 본문까지 내려받지 않도록 meta만 DB에서 꺼낸다
  const rows = await prisma.$queryRaw<{ key: string; meta: TrashMeta | null }[]>`
    SELECT key, (value::jsonb -> 'meta') AS meta FROM "AppSetting" WHERE left(key, ${prefix.length}) = ${prefix}`;
  return rows
    .map((r) => r.meta)
    .filter((m): m is TrashMeta => !!m && typeof m.id === "string")
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

async function createSection(tx: Prisma.TransactionClient, chapterId: string, order: number, s: SectionSnap) {
  if (await tx.section.findUnique({ where: { id: s.id }, select: { id: true } })) throw err("같은 절이 이미 있습니다.", 409);
  await tx.section.create({
    data: {
      id: s.id,
      chapterId,
      order,
      title: s.title,
      gist: s.gist,
      hook: s.hook,
      targetPages: s.targetPages,
      status: s.status,
      sketch: s.sketch,
      content: s.content,
      charCount: s.charCount,
      summary: s.summary,
      summaryHash: s.summaryHash,
    },
  });
  if (s.versions.length)
    await tx.version.createMany({
      data: s.versions.map((v) => ({ id: v.id, sectionId: s.id, reason: v.reason, content: v.content, charCount: v.charCount, createdAt: new Date(v.createdAt) })),
      skipDuplicates: true,
    });
}

/** 되돌리기 — 같은 id로 다시 만들고 원래 자리에 끼운다. 휴지통 항목은 지운다 */
export async function restoreTrash(projectId: string, trashId: string) {
  const prisma = await db();
  const key = trashKey(projectId, String(trashId ?? ""));
  const row = await prisma.appSetting.findUnique({ where: { key } });
  if (!row) throw err("휴지통에서 찾을 수 없습니다. 이미 되돌렸거나 보관 기간(30일)이 지났습니다.", 404);
  const e = JSON.parse(row.value) as TrashEntry;
  if (e.projectId !== projectId) throw err("휴지통에서 찾을 수 없습니다.", 404);

  return prisma.$transaction(
    async (tx) => {
      if (e.meta.kind === "section" && e.section && e.chapterId) {
        const ch = await tx.chapter.findUnique({ where: { id: e.chapterId }, select: { projectId: true } });
        if (!ch || ch.projectId !== projectId) throw err("이 절이 있던 장이 지워졌습니다. 먼저 그 장을 되돌리세요.", 409);
        const ids = (await tx.section.findMany({ where: { chapterId: e.chapterId }, orderBy: { order: "asc" }, select: { id: true } })).map((x) => x.id);
        ids.splice(insertIndex(ids.length, e.index), 0, e.section.id);
        await createSection(tx, e.chapterId, ids.indexOf(e.section.id) + 1, e.section);
        for (const [i, sid] of ids.entries()) if (sid !== e.section.id) await tx.section.update({ where: { id: sid }, data: { order: i + 1 } });
      } else if (e.meta.kind === "chapter" && e.chapter) {
        const c = e.chapter;
        if (await tx.chapter.findUnique({ where: { id: c.id }, select: { id: true } })) throw err("같은 장이 이미 있습니다.", 409);
        const all = await tx.chapter.findMany({ where: { projectId }, orderBy: { order: "asc" }, select: { id: true, kind: true } });
        const kind = (e.chapterKind ?? c.kind ?? "body") as Kind;
        const at = chapterInsertIndex(all, kind, e.index);
        await tx.chapter.create({ data: { id: c.id, projectId, kind, order: at + 1, title: c.title, promise: c.promise, summary: c.summary, summaryHash: c.summaryHash } });
        for (const [i, s] of c.sections.entries()) await createSection(tx, c.id, i + 1, s);
        const ids = all.map((x) => x.id);
        ids.splice(at, 0, c.id);
        for (const [i, cid] of ids.entries()) if (cid !== c.id) await tx.chapter.update({ where: { id: cid }, data: { order: i + 1 } });
      } else throw err("휴지통 항목이 손상되었습니다.");
      await tx.appSetting.delete({ where: { key } });
      return { id: e.meta.id, kind: e.meta.kind, versionsDropped: !!e.meta.versionsDropped };
    },
    { timeout: 30_000 },
  );
}

/** 오래된 휴지통 항목 비우기 (지운 시각 = updatedAt) */
export async function purgeTrash(olderThanDays = TRASH_KEEP_DAYS) {
  const prisma = await db();
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const r = await prisma.appSetting.deleteMany({ where: { key: { startsWith: TRASH_PREFIX }, updatedAt: { lt: cutoff } } });
  return r.count;
}
