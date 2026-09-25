import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { charCount, parseDoc } from "./doc/doc";
import { sectionInput } from "./section-input";
import { versionsToDrop } from "./version-policy";

const STATUSES = new Set(["empty", "sketch", "ai_draft", "editing", "proofread"]);

type Tx = Prisma.TransactionClient;

/** 오래된 버전 정리 — 버전을 만든 같은 트랜잭션 안에서 부른다 (본문은 읽지 않는다) */
export async function pruneVersions(tx: Tx, sectionId: string) {
  const rows = await tx.version.findMany({
    where: { sectionId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, reason: true, createdAt: true },
  });
  const drop = versionsToDrop(rows);
  if (drop.length) await tx.version.deleteMany({ where: { id: { in: drop } } });
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
    // 자동 저장은 1초마다 올 수 있으므로 필요한 칸만 읽는다
    const current = b.content === undefined || opts.skipAutosave ? null : await tx.section.findUniqueOrThrow({ where: { id }, select: { content: true, charCount: true } });
    if (current && b.content !== current.content && current.charCount > 0) {
      const latest = await tx.version.findFirst({ where: { sectionId: id, reason: "autosave" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
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
