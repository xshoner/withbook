import { after } from "next/server";
import { prisma, rawTable } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { dailyMaintenance } from "@/lib/maintenance";
import { readGlobalStyle } from "@/lib/style/global";
import { DEFAULT_LAYOUT } from "@/lib/layout";
import { listPages, parsePageCount } from "@/lib/print/page-count";
import { deadlinePlan } from "@/lib/progress";

/**
 * 책 목록 — 절 행을 다 읽지 않고 DB에서 장별로 모아(groupBy) 책별 글자 수·절 수·마지막 수정을 계산한다.
 * 쪽수는 집필 화면이 잰 실제 조판 쪽수(AppSetting pages:{id})를 쓴다 — 잰 뒤 바뀐 글자만큼만 어림해 더한다.
 * 하루 한 번 정리(dailyMaintenance)는 응답을 보낸 뒤(after) 돈다.
 * 이어 쓰기 카드: 마지막으로 고친 절(장마다 최신 1개만 읽는다)과 다음 빈 절(본문 장의 첫 빈 절) — 본문은 읽지 않는다.
 * 진행 현황: 마감일(AppSetting deadline:{id})과 남은 확인 표시 수 — 표시 수는 DB 안에서 세어 본문을 내려받지 않는다.
 */
export const GET = handle(async () => {
  after(() => dailyMaintenance().catch((e) => console.warn("[maintenance]", e?.message)));
  const [projects, chapters, all, written, measured, recent, empty, deadlines, marks] = await Promise.all([
    prisma.project.findMany({
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, subtitle: true, author: true, targetPages: true, charsPerPage: true, createdAt: true, updatedAt: true, deletedAt: true },
    }),
    prisma.chapter.findMany({ select: { id: true, projectId: true, order: true, kind: true } }),
    prisma.section.groupBy({ by: ["chapterId"], _sum: { charCount: true }, _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.section.groupBy({ by: ["chapterId"], where: { charCount: { gt: 0 } }, _count: { _all: true } }),
    prisma.appSetting.findMany({ where: { key: { startsWith: "pages:" } }, select: { key: true, value: true } }),
    prisma.section.findMany({ where: { charCount: { gt: 0 } }, orderBy: [{ chapterId: "asc" }, { updatedAt: "desc" }], distinct: ["chapterId"], select: { id: true, title: true, chapterId: true, updatedAt: true } }),
    prisma.section.findMany({ where: { charCount: 0 }, select: { id: true, title: true, chapterId: true, order: true } }),
    prisma.appSetting.findMany({ where: { key: { startsWith: "deadline:" } }, select: { key: true, value: true } }),
    // [확인 필요]·[이미지 제안] 표시 수 (팩트체크 창과 같은 표시) — 글자 수 차이로 센다
    prisma.$queryRaw<{ pid: string; n: number }[]>`
      SELECT c."projectId" AS pid,
        SUM((length(s.content) - length(replace(s.content, '[확인 필요', ''))) / length('[확인 필요')
          + (length(s.content) - length(replace(s.content, '[이미지 제안', ''))) / length('[이미지 제안'))::int AS n
      FROM ${rawTable("Section")} s JOIN ${rawTable("Chapter")} c ON c.id = s."chapterId"
      WHERE s.content LIKE '%[확인 필요%' OR s.content LIKE '%[이미지 제안%'
      GROUP BY c."projectId"`,
  ]);
  const deadlineOf = new Map(deadlines.map((d) => [d.key.slice("deadline:".length), d.value]));
  const marksOf = new Map(marks.map((m) => [m.pid, Number(m.n) || 0]));
  const chapterOf = new Map(chapters.map((c) => [c.id, c]));
  const lastOf = new Map<string, { sectionId: string; title: string; at: Date }>();
  for (const s of recent) {
    const pid = chapterOf.get(s.chapterId)?.projectId;
    if (pid && (!lastOf.has(pid) || s.updatedAt > lastOf.get(pid)!.at)) lastOf.set(pid, { sectionId: s.id, title: s.title, at: s.updatedAt });
  }
  const nextOf = new Map<string, { sectionId: string; title: string; rank: number }>();
  for (const s of empty) {
    const c = chapterOf.get(s.chapterId);
    if (!c || c.kind !== "body") continue;
    const rank = c.order * 10_000 + s.order;
    if (!nextOf.has(c.projectId) || rank < nextOf.get(c.projectId)!.rank) nextOf.set(c.projectId, { sectionId: s.id, title: s.title, rank });
  }
  const measuredOf = new Map(measured.map((m) => [m.key.slice("pages:".length), parsePageCount(m.value)]));
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
      const pages = listPages(st.chars, p.charsPerPage, measuredOf.get(p.id) ?? null);
      const deadline = deadlineOf.get(p.id) ?? null;
      return {
        id: p.id,
        title: p.title,
        subtitle: p.subtitle,
        author: p.author,
        targetPages: p.targetPages,
        estPages: pages.pages,
        pagesExact: pages.exact,
        sections: st.sections,
        written: st.written,
        createdAt: p.createdAt,
        updatedAt: st.last && st.last > p.updatedAt ? st.last : p.updatedAt,
        deletedAt: p.deletedAt,
        last: lastOf.has(p.id) ? { sectionId: lastOf.get(p.id)!.sectionId, title: lastOf.get(p.id)!.title } : null,
        checks: marksOf.get(p.id) ?? 0,
        deadline,
        plan: deadline ? deadlinePlan(deadline, pages.pages, p.targetPages) : null,
        next: nextOf.has(p.id) ? { sectionId: nextOf.get(p.id)!.sectionId, title: nextOf.get(p.id)!.title } : null,
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
