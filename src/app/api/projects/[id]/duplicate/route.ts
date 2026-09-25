import path from "node:path";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { assetKey } from "@/lib/backup";
import { copyObject, mapLimit, removeObjects } from "@/lib/storage";

export const maxDuration = 300;

export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/duplicate">) => {
  const { id } = await ctx.params;
  const p = await prisma.project.findUnique({
    where: { id },
    include: { chapters: { include: { sections: true } }, glossary: true, assets: true },
  });
  if (!p) return fail("프로젝트를 찾을 수 없습니다.", 404);
  // 1) DB 복사는 한 트랜잭션으로 (중간에 실패하면 반쪽 프로젝트가 남지 않는다)
  const { copy, files } = await prisma.$transaction(
    async (tx) => {
      const copy = await tx.project.create({
        data: {
          title: p.title + " (복사본)",
          subtitle: p.subtitle,
          author: p.author,
          topic: p.topic,
          intent: p.intent,
          audience: p.audience,
          keyMessage: p.keyMessage,
          tone: p.tone,
          references: p.references,
          targetPages: p.targetPages,
          extra: p.extra,
          styleProfile: p.styleProfile,
          styleSamples: p.styleSamples,
          layout: p.layout,
          charsPerPage: p.charsPerPage,
          glossary: { create: p.glossary.map((g) => ({ term: g.term, preferred: g.preferred, note: g.note })) },
        },
      });
      // 이미지 행 복사 (ID 재매핑) — ID·경로를 미리 정해 한 번에 넣고, 파일 복사는 트랜잭션 밖에서
      const idMap = new Map<string, string>();
      const files: { from: string; to: string; mime: string }[] = [];
      const rows = p.assets.map((a) => {
        const nid = "c" + randomBytes(12).toString("hex");
        const dest = assetKey(copy.id, nid, path.extname(a.path));
        idMap.set(a.id, nid);
        files.push({ from: a.path, to: dest, mime: a.mime });
        return { id: nid, projectId: copy.id, filename: a.filename, mime: a.mime, widthPx: a.widthPx, heightPx: a.heightPx, path: dest };
      });
      if (rows.length) await tx.asset.createMany({ data: rows });
      const remap = (content: string) => {
        let c = content;
        idMap.forEach((nid, oid) => (c = c.split(oid).join(nid)));
        return c;
      };
      for (const c of p.chapters) {
        await tx.chapter.create({
          data: {
            projectId: copy.id,
            order: c.order,
            title: c.title,
            kind: c.kind,
            promise: c.promise,
            sections: {
              create: c.sections.map((s) => ({
                order: s.order,
                title: s.title,
                gist: s.gist,
                hook: s.hook,
                targetPages: s.targetPages,
                status: s.status,
                sketch: s.sketch,
                content: remap(s.content),
                charCount: s.charCount,
                summary: s.summary,
                summaryHash: s.summaryHash,
              })),
            },
          },
        });
      }
      return { copy, files };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  // 2) 이미지 파일 복사 — 실패하면 만든 복사본을 지우고 오류
  const written: string[] = [];
  try {
    await mapLimit(files, 4, async (f) => {
      if (await copyObject("assets", f.from, f.to, f.mime)) written.push(f.to);
    });
  } catch (e) {
    await removeObjects("assets", written).catch(() => {});
    await prisma.project.delete({ where: { id: copy.id } }).catch(() => {});
    throw e;
  }
  return ok({ id: copy.id });
});
