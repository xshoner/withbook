import { z } from "zod";
import { fail, handle, ok } from "@/lib/api";
import { prisma } from "@/lib/db";
import { editSections } from "@/lib/section-edit";
import { parseDoc } from "@/lib/doc/doc";
import { undoBlockChanges } from "@/lib/doc/edit";
import { contentHash, getReviseRun, updateReviseRun } from "@/lib/revise-log";

const body = z.object({ runId: z.string().min(1).max(40) });

/**
 * 한 번의 장 퇴고를 통째로 되돌린다.
 * - 그 뒤 손대지 않은 절: 퇴고 전 버전으로 그대로 되돌린다.
 * - 그 뒤 고친 절: 퇴고로 바뀐 문단만 거꾸로 바꿔 되돌린다(나중에 고친 곳은 지키고, 찾지 못한 곳은 건너뛰고 알린다).
 * 되돌리기 전 원고는 절마다 버전(revise_undo)으로 남는다.
 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/chapters/[id]/revise/undo">) => {
  const { id } = await ctx.params;
  const { runId } = body.parse(await req.json());
  const chapter = await prisma.chapter.findUnique({ where: { id }, select: { projectId: true } });
  if (!chapter) return fail("장을 찾을 수 없습니다.", 404);
  const run = await getReviseRun(chapter.projectId, id, runId);
  if (!run) return fail("퇴고 기록을 찾을 수 없습니다(30일이 지나 정리됐을 수 있습니다).", 404);
  if (run.undoneAt) return fail("이미 되돌린 퇴고입니다.");

  const versionIds = run.sections.map((s) => s.versionId).filter((v): v is string => !!v);
  const versions = new Map((await prisma.version.findMany({ where: { id: { in: versionIds } }, select: { id: true, content: true } })).map((v) => [v.id, v.content]));
  const bySection = new Map(run.sections.map((s) => [s.sectionId, s]));
  const outcome = new Map<string, { restored: boolean; reverted: number; failed: number }>();

  const changed = await editSections([...bySection.keys()], "revise_undo", (doc, sid, raw) => {
    const s = bySection.get(sid)!;
    const before = s.versionId ? versions.get(s.versionId) : undefined;
    // 퇴고 직후 그대로인 절만 퇴고 전 버전으로 통째로 되돌린다
    const r = undoBlockChanges(doc, s.changes, before && contentHash(raw) === s.afterHash ? parseDoc(before) : null);
    outcome.set(sid, r);
    return r.doc;
  });

  const done = new Set(changed);
  let restored = 0;
  let reverted = 0;
  let failed = 0;
  for (const s of run.sections) {
    const o = outcome.get(s.sectionId);
    if (o && done.has(s.sectionId)) {
      if (o.restored) restored++;
      reverted += o.reverted;
      failed += o.failed;
    } else failed += s.changes.length;
  }
  await updateReviseRun({ ...run, undoneAt: new Date().toISOString(), undo: { restored, reverted, failed } });
  return ok({ sections: changed, restored, reverted, failed });
});
