import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { charCount, contentHash, parseDoc } from "./doc/doc";
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

/** 저장 충돌 — 화면이 기준으로 삼은 본문(baseHash)과 지금 저장된 본문이 다르다. 라우트가 409와 서버 본문으로 돌려준다 */
export class SaveConflictError extends Error {
  status = 409;
  constructor(public current: { content: string; contentHash: string; updatedAt: Date }) {
    super("다른 창이나 서버 작업(바꾸기·장 퇴고·팩트체크 등)이 이 절을 먼저 고쳤습니다.");
  }
}

/**
 * 절 저장. 내용이 바뀌면 5분에 한 번 이전 내용을 autosave 버전으로 보관한다.
 * opts.tx: 바깥 트랜잭션 안에서 실행 · opts.skipAutosave: 호출자가 이미 버전을 남긴 경우(복원 등)
 * opts.baseHash: 화면이 기준으로 삼은 본문의 해시(contentHash) — 지금 저장된 본문과 다르면 덮지 않고 SaveConflictError.
 *   없으면 확인하지 않는다 (서버 작업·예전 화면과 호환)
 */
export async function saveSection(
  id: string,
  b: { content?: string; sketch?: string; status?: string },
  opts: { tx?: Tx; skipAutosave?: boolean; baseHash?: string } = {},
) {
  b = sectionInput.parse(b);
  const data: Record<string, unknown> = {};
  if (typeof b.content === "string") {
    data.content = b.content;
    data.charCount = charCount(parseDoc(b.content));
  }
  if (typeof b.sketch === "string") data.sketch = b.sketch;
  if (b.status && STATUSES.has(b.status)) data.status = b.status;
  const check = b.content !== undefined && !!opts.baseHash;
  const select = { updatedAt: true, charCount: true, status: true } as const;
  const run = async (tx: Tx) => {
    // 자동 저장은 1초마다 올 수 있으므로 필요한 칸만 읽는다
    const current = b.content === undefined || (opts.skipAutosave && !check) ? null : await tx.section.findUniqueOrThrow({ where: { id }, select: { content: true, charCount: true, updatedAt: true } });
    if (check && current && contentHash(current.content) !== opts.baseHash) {
      throw new SaveConflictError({ content: current.content, contentHash: contentHash(current.content), updatedAt: current.updatedAt });
    }
    if (current && !opts.skipAutosave && b.content !== current.content && current.charCount > 0) {
      const latest = await tx.version.findFirst({ where: { sectionId: id, reason: "autosave" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
      if (!latest || Date.now() - latest.createdAt.getTime() >= 5 * 60_000) {
        await tx.version.create({ data: { sectionId: id, reason: "autosave", content: current.content, charCount: current.charCount } });
        await pruneVersions(tx, id);
      }
    }
    const withHash = <T extends object>(r: T) => (typeof b.content === "string" ? { ...r, contentHash: contentHash(b.content) } : r);
    if (check && current) {
      // 읽은 뒤 다른 저장이 끼어들었으면(같은 순간 두 창) 덮지 않는다 — 읽은 본문 그대로일 때만 쓴다
      const n = await tx.section.updateMany({ where: { id, content: current.content }, data });
      if (!n.count) {
        const now = await tx.section.findUniqueOrThrow({ where: { id }, select: { content: true, updatedAt: true } });
        throw new SaveConflictError({ content: now.content, contentHash: contentHash(now.content), updatedAt: now.updatedAt });
      }
      return withHash(await tx.section.findUniqueOrThrow({ where: { id }, select }));
    }
    return withHash(await tx.section.update({ where: { id }, data, select }));
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
