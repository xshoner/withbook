import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "./db";

/**
 * 장 퇴고 기록 — 한 번 적용할 때(run) 장 안의 여러 절에 걸쳐 바뀐 문단을 모두 남긴다.
 * 절마다 남는 버전(chapter_revise)만으로는 그 절의 바뀐 곳만 보이고, 지금 원고와 비교하면 그 뒤 고친 것까지 섞여 보인다.
 *   revise-run:{책}:{장}:{run}  → ReviseRun (장 전체 수정 목록, 절별 적용 전 버전 id, 적용 직후 원고 해시)
 *   revise-ver:{버전}           → { key, here, total } (버전 기록에서 바로 찾기)
 * 30일 지나면 하루 한 번 정리(maintenance)에서 지운다. 책을 영구 삭제하면 함께 지운다.
 */
export const RUN_PREFIX = "revise-run:";
export const VER_PREFIX = "revise-ver:";

export type ReviseChangeLog = { paragraph: number; before: string; after: string; type: string; reason: string };
export type ReviseSectionLog = { sectionId: string; label: string; title: string; versionId: string | null; afterHash: string; changes: ReviseChangeLog[] };
export type ReviseRun = {
  runId: string;
  projectId: string;
  chapterId: string;
  chapterName: string;
  at: string;
  focus: string;
  total: number;
  sections: ReviseSectionLog[];
  /** 되돌린 때 — 되돌린 기록은 다시 되돌리지 않는다 */
  undoneAt?: string;
  undo?: { restored: number; reverted: number; failed: number };
};

/** 원고 해시 — 장 퇴고 직후 원고와 지금 원고가 같은지(그 뒤 손대지 않았는지) 본다 */
export const contentHash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 20);
export const runKey = (projectId: string, chapterId: string, runId: string) => `${RUN_PREFIX}${projectId}:${chapterId}:${runId}`;

export async function saveReviseRun(run: ReviseRun) {
  const key = runKey(run.projectId, run.chapterId, run.runId);
  await prisma.appSetting.create({ data: { key, value: JSON.stringify(run) } });
  const pointers = run.sections
    .filter((s) => s.versionId)
    .map((s) => ({ key: `${VER_PREFIX}${s.versionId}`, value: JSON.stringify({ key, here: s.changes.length, total: run.total }) }));
  if (pointers.length) await prisma.appSetting.createMany({ data: pointers, skipDuplicates: true });
  return key;
}

const parse = (value: string | undefined | null): ReviseRun | null => {
  if (!value) return null;
  try {
    const v = JSON.parse(value);
    return v && Array.isArray(v.sections) ? v : null;
  } catch {
    return null;
  }
};

/** 이 장의 퇴고 기록 (새것부터) */
export async function listReviseRuns(projectId: string, chapterId: string, limit = 20): Promise<ReviseRun[]> {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: `${RUN_PREFIX}${projectId}:${chapterId}:` } }, select: { value: true } });
  return rows
    .map((r) => parse(r.value))
    .filter((r): r is ReviseRun => !!r)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

export async function getReviseRun(projectId: string, chapterId: string, runId: string) {
  const row = await prisma.appSetting.findUnique({ where: { key: runKey(projectId, chapterId, runId) } });
  return parse(row?.value);
}

/** 버전 id → 그 퇴고 기록의 요약 (여러 버전을 한 번에) */
export async function revisePointers(versionIds: string[]): Promise<Map<string, { here: number; total: number }>> {
  const out = new Map<string, { here: number; total: number }>();
  if (!versionIds.length) return out;
  const rows = await prisma.appSetting.findMany({ where: { key: { in: versionIds.map((v) => `${VER_PREFIX}${v}`) } } });
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value);
      out.set(r.key.slice(VER_PREFIX.length), { here: Number(v.here) || 0, total: Number(v.total) || 0 });
    } catch {}
  }
  return out;
}

/** 버전 id로 그 퇴고 기록 전체 */
export async function reviseRunForVersion(versionId: string) {
  const ptr = await prisma.appSetting.findUnique({ where: { key: `${VER_PREFIX}${versionId}` } });
  if (!ptr) return null;
  try {
    const { key } = JSON.parse(ptr.value);
    if (typeof key !== "string" || !key.startsWith(RUN_PREFIX)) return null;
    const row = await prisma.appSetting.findUnique({ where: { key } });
    return parse(row?.value);
  } catch {
    return null;
  }
}

export async function updateReviseRun(run: ReviseRun) {
  await prisma.appSetting.update({ where: { key: runKey(run.projectId, run.chapterId, run.runId) }, data: { value: JSON.stringify(run) } });
}

/** 30일 지난 퇴고 기록 정리 */
export async function purgeReviseLogs(days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
  await prisma.appSetting.deleteMany({ where: { OR: [{ key: { startsWith: RUN_PREFIX } }, { key: { startsWith: VER_PREFIX } }], updatedAt: { lt: cutoff } } });
}
