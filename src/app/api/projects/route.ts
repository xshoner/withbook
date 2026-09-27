import { after } from "next/server";
import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { dailyMaintenance } from "@/lib/maintenance";
import { readGlobalStyle } from "@/lib/style/global";
import { DEFAULT_LAYOUT } from "@/lib/layout";

/**
 * 책 목록 — 절 행을 다 읽지 않고 DB에서 장별로 모아(groupBy) 책별 글자 수·절 수·마지막 수정을 계산한다.
 * 하루 한 번 정리(dailyMaintenance)는 응답을 보낸 뒤(after) 돈다.
 */
export const GET = handle(async () => {
  after(() => dailyMaintenance().catch((e) => console.warn("[maintenance]", e?.message)));
  const [projects, chapters, all, written] = await Promise.all([
    prisma.project.findMany({
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, subtitle: true, author: true, targetPages: true, charsPerPage: true, updatedAt: true, deletedAt: true },
    }),
    prisma.chapter.findMany({ select: { id: true, projectId: true } }),
    prisma.section.groupBy({ by: ["chapterId"], _sum: { charCount: true }, _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.section.groupBy({ by: ["chapterId"], where: { charCount: { gt: 0 } }, _count: { _all: true } }),
  ]);
  const projectOf = new Map(chapters.map((c) => [c.id, c.projectId]));
  const stats = new Map<string, { chars: number; sections: number; written: number; last: Date | null }>();
  const statOf = (chapterId: string) => {
    const pid = projectOf.get(chapterId);
    if (!pid) return null;
    let st = stats.get(pid);
    if (!st) stats.set(pid, (st = { chars: 0, sections: 0, written: 0, last: null }));
    return st;
  };
  for (const g of all) {
    const st = statOf(g.chapterId);
    if (!st) continue;
    st.chars += g._sum.charCount ?? 0;
    st.sections += g._count._all;
    const at = g._max.updatedAt;
    if (at && (!st.last || at > st.last)) st.last = at;
  }
  for (const g of written) {
    const st = statOf(g.chapterId);
    if (st) st.written += g._count._all;
  }
  return ok(
    projects.map((p) => {
      const st = stats.get(p.id) ?? { chars: 0, sections: 0, written: 0, last: null };
      return {
        id: p.id,
        title: p.title,
        subtitle: p.subtitle,
        author: p.author,
        targetPages: p.targetPages,
        estPages: Math.round(st.chars / (p.charsPerPage || 700)),
        sections: st.sections,
        written: st.written,
        updatedAt: st.last && st.last > p.updatedAt ? st.last : p.updatedAt,
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
