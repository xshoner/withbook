import path from "node:path";
import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { assetKey } from "@/lib/backup";
import { getObject, putObject } from "@/lib/storage";

export const maxDuration = 300;

export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/duplicate">) => {
  const { id } = await ctx.params;
  const p = await prisma.project.findUnique({
    where: { id },
    include: { chapters: { include: { sections: true } }, glossary: true, assets: true },
  });
  if (!p) return fail("프로젝트를 찾을 수 없습니다.", 404);
  const copy = await prisma.project.create({
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
  // 이미지 복사 (ID 재매핑)
  const idMap = new Map<string, string>();
  for (const a of p.assets) {
    const na = await prisma.asset.create({
      data: { projectId: copy.id, filename: a.filename, mime: a.mime, widthPx: a.widthPx, heightPx: a.heightPx, path: "" },
    });
    const dest = assetKey(copy.id, na.id, path.extname(a.path));
    const buf = await getObject("assets", a.path);
    if (buf) await putObject("assets", dest, buf, a.mime);
    await prisma.asset.update({ where: { id: na.id }, data: { path: dest } });
    idMap.set(a.id, na.id);
  }
  const remap = (content: string) => {
    let c = content;
    idMap.forEach((nid, oid) => (c = c.split(oid).join(nid)));
    return c;
  };
  for (const c of p.chapters) {
    await prisma.chapter.create({
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
  return ok({ id: copy.id });
});
