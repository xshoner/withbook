import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { dailyMaintenance } from "@/lib/backup";
import { readGlobalStyle } from "@/lib/style/global";
import { DEFAULT_LAYOUT } from "@/lib/layout";

export const GET = handle(async () => {
  await dailyMaintenance();
  const projects = await prisma.project.findMany({
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      subtitle: true,
      author: true,
      targetPages: true,
      charsPerPage: true,
      updatedAt: true,
      deletedAt: true,
      chapters: { select: { sections: { select: { charCount: true, status: true, updatedAt: true } } } },
    },
  });
  return ok(
    projects.map((p) => {
      const secs = p.chapters.flatMap((c) => c.sections);
      const chars = secs.reduce((s, x) => s + x.charCount, 0);
      const last = secs.reduce((m, s) => (s.updatedAt > m ? s.updatedAt : m), p.updatedAt);
      return {
        id: p.id,
        title: p.title,
        subtitle: p.subtitle,
        author: p.author,
        targetPages: p.targetPages,
        estPages: Math.round(chars / (p.charsPerPage || 700)),
        sections: secs.length,
        written: secs.filter((s) => s.charCount > 0).length,
        updatedAt: last,
        deletedAt: p.deletedAt,
      };
    }),
  );
});

export const POST = handle(async (req: Request) => {
  const b = await req.json();
  if (!b.title?.trim()) return fail("책 제목을 입력하세요.");
  const g = await readGlobalStyle();
  const layout = { ...DEFAULT_LAYOUT, colophon: { ...DEFAULT_LAYOUT.colophon } };
  const project = await prisma.project.create({
    data: {
      title: b.title.trim(),
      subtitle: b.subtitle ?? "",
      author: b.author ?? "",
      topic: b.topic ?? "",
      intent: b.intent ?? "",
      audience: b.audience ?? "",
      keyMessage: b.keyMessage ?? "",
      tone: b.tone ?? "",
      references: b.references ?? "",
      targetPages: Number(b.targetPages) || 200,
      extra: b.extra ?? "",
      styleProfile: g ? JSON.stringify(g.profile) : null,
      layout: JSON.stringify(layout),
    },
  });
  return ok({ id: project.id });
});
