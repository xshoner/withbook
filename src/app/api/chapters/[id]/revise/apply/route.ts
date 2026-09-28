import { z } from "zod";
import { fail, handle, ok } from "@/lib/api";
import { prisma } from "@/lib/db";
import { applyBlockChanges } from "@/lib/doc/edit";
import { editSections } from "@/lib/section-edit";
import { type ReviseRun, contentHash, saveReviseRun } from "@/lib/revise-log";

const body = z.object({
  changes: z
    .array(
      z.object({
        sectionId: z.string(),
        paragraph: z.number().int().positive(),
        before: z.string().min(1),
        after: z.string(),
        // 기록용 (화면이 퇴고안에서 받은 값을 그대로 넘긴다)
        type: z.string().max(40).optional(),
        reason: z.string().max(600).optional(),
        sectionLabel: z.string().max(80).optional(),
        sectionTitle: z.string().max(300).optional(),
      }),
    )
    .min(1)
    .max(200),
  chapterName: z.string().max(300).optional(),
  focus: z.string().max(500).optional(),
});

type Change = z.infer<typeof body>["changes"][number];

/**
 * 작가가 고른 퇴고안만 적용 — 절마다 적용 전 원고를 버전(chapter_revise)으로 남기고,
 * 장 전체에서 실제로 바뀐 문단을 퇴고 기록(revise-run)으로 남긴다(버전 기록·퇴고 이력에서 한눈에 보고 되돌리기).
 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/chapters/[id]/revise/apply">) => {
  const { id } = await ctx.params;
  const { changes, chapterName, focus } = body.parse(await req.json());
  const chapter = await prisma.chapter.findUnique({ where: { id }, select: { projectId: true, title: true, sections: { select: { id: true, title: true } } } });
  if (!chapter) return fail("장을 찾을 수 없습니다.", 404);
  const inChapter = new Map(chapter.sections.map((s) => [s.id, s]));
  if (changes.some((c) => !inChapter.has(c.sectionId))) return fail("이 장에 없는 절의 수정이 들어 있습니다.");
  const bySection = Map.groupBy(changes, (c) => c.sectionId);
  // 절마다 마지막으로 적용한 결과만 센다 (저장 직전에 원고가 바뀌어 fn이 다시 불려도 두 번 세지 않게)
  const result = new Map<string, { applied: Change[]; failed: Change[] }>();
  const saved = new Map<string, { content: string; versionId: string | null }>();
  const changed = await editSections(
    [...bySection.keys()],
    "chapter_revise",
    (doc, sid) => {
      const r = applyBlockChanges(doc, bySection.get(sid) ?? []);
      result.set(sid, { applied: r.applied, failed: r.failed });
      return r.applied.length ? r.doc : null;
    },
    { onSaved: (sid, content, versionId) => saved.set(sid, { content, versionId }) },
  );
  const done = new Set(changed);
  let applied = 0;
  let failed = 0;
  for (const [sid, list] of bySection) {
    const r = result.get(sid);
    if (r && done.has(sid)) {
      applied += r.applied.length;
      failed += r.failed.length;
    } else failed += list.length;
  }

  let runId: string | null = null;
  if (changed.length) {
    // 목차 순서대로 (퇴고안이 온 순서가 아니라)
    const order = new Map(changes.map((c, i) => [c.sectionId, i]));
    const sections = changed
      .toSorted((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      .map((sid) => {
        const first = bySection.get(sid)![0];
        const s = saved.get(sid);
        return {
          sectionId: sid,
          label: first.sectionLabel ?? "",
          title: first.sectionTitle || inChapter.get(sid)?.title || "",
          versionId: s?.versionId ?? null,
          afterHash: s ? contentHash(s.content) : "",
          changes: (result.get(sid)?.applied ?? [])
            .map((c) => ({ paragraph: c.paragraph, before: c.before, after: c.after, type: c.type ?? "", reason: c.reason ?? "" }))
            .sort((a, b) => a.paragraph - b.paragraph),
        };
      });
    const run: ReviseRun = {
      runId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      projectId: chapter.projectId,
      chapterId: id,
      chapterName: chapterName || chapter.title,
      at: new Date().toISOString(),
      focus: focus ?? "",
      total: sections.reduce((n, s) => n + s.changes.length, 0),
      sections,
    };
    try {
      await saveReviseRun(run);
      runId = run.runId;
    } catch (e: any) {
      // 기록을 못 남겨도 적용한 원고와 절별 버전은 그대로 — 알리기만 한다
      console.warn("[revise] 퇴고 기록 저장 실패", e?.message);
    }
  }
  return ok({ applied, failed, sections: changed, runId });
});
