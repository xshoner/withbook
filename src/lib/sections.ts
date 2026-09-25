import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { charCount, parseDoc } from "./doc/doc";
import { sectionInput } from "./section-input";

const STATUSES = new Set(["empty", "sketch", "ai_draft", "editing", "proofread"]);

type Tx = Prisma.TransactionClient;

/** 절당 보관 개수: 자동 저장 30 · 직접 저장 30 · 그 밖(AI 집필·교정·복원 등) 합쳐서 50 */
const KEEP = { autosave: 30, manual: 30, other: 50 };

/** 오래된 버전 정리 — 버전을 만든 같은 트랜잭션 안에서 부른다 */
export async function pruneVersions(tx: Tx, sectionId: string) {
  const groups: { where: Prisma.VersionWhereInput; keep: number }[] = [
    { where: { sectionId, reason: "autosave" }, keep: KEEP.autosave },
    { where: { sectionId, reason: "manual" }, keep: KEEP.manual },
    { where: { sectionId, reason: { notIn: ["autosave", "manual"] } }, keep: KEEP.other },
  ];
  for (const g of groups) {
    const old = await tx.version.findMany({ where: g.where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: g.keep, select: { id: true } });
    if (old.length) await tx.version.deleteMany({ where: { id: { in: old.map((v) => v.id) } } });
  }
}

/**
 * 절 저장. 내용이 바뀌면 5분에 한 번 이전 내용을 autosave 버전으로 보관한다.
 * opts.tx: 바깥 트랜잭션 안에서 실행 · opts.skipAutosave: 호출자가 이미 버전을 남긴 경우(복원 등)
 */
export async function saveSection(
  id: string,
  b: { content?: string; sketch?: string; status?: string },
  opts: { tx?: Tx; skipAutosave?: boolean } = {},
) {
  b = sectionInput.parse(b);
  const data: Record<string, unknown> = {};
  if (typeof b.content === "string") {
    data.content = b.content;
    data.charCount = charCount(parseDoc(b.content));
  }
  if (typeof b.sketch === "string") data.sketch = b.sketch;
  if (b.status && STATUSES.has(b.status)) data.status = b.status;
  const run = async (tx: Tx) => {
    const current = await tx.section.findUniqueOrThrow({ where: { id } });
    if (!opts.skipAutosave && b.content !== undefined && b.content !== current.content && current.charCount > 0) {
      const latest = await tx.version.findFirst({ where: { sectionId: id, reason: "autosave" }, orderBy: { createdAt: "desc" } });
      if (!latest || Date.now() - latest.createdAt.getTime() >= 5 * 60_000) {
        await tx.version.create({ data: { sectionId: id, reason: "autosave", content: current.content, charCount: current.charCount } });
        await pruneVersions(tx, id);
      }
    }
    return tx.section.update({ where: { id }, data, select: { updatedAt: true, charCount: true, status: true } });
  };
  return opts.tx ? run(opts.tx) : prisma.$transaction(run);
}

/** 버전 보관 (content가 없으면 지금 저장된 내용). 만들기와 정리를 한 트랜잭션으로 */
export async function snapshot(sectionId: string, reason: string, content?: string, tx?: Tx) {
  const run = async (t: Tx) => {
    let c = content;
    if (c === undefined) {
      const s = await t.section.findUnique({ where: { id: sectionId }, select: { content: true } });
      c = s?.content ?? "";
    }
    const n = charCount(parseDoc(c));
    if (!n && reason !== "manual") return null;
    const v = await t.version.create({ data: { sectionId, reason, content: c, charCount: n } });
    await pruneVersions(t, sectionId);
    return v;
  };
  return tx ? run(tx) : prisma.$transaction(run);
}
