import "server-only";
import { prisma } from "./db";
import { numberChapters, parseLayout } from "./layout";
import { readMemoryText } from "./book-memory-store";

export async function loadBook(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      chapters: { orderBy: { order: "asc" }, include: { sections: { orderBy: { order: "asc" } } } },
      glossary: true,
    },
  });
  if (!project) return null;
  const layout = parseLayout(project.layout);
  const numbered = numberChapters(project.chapters, layout.numberFormat);
  return { project: { ...project, bookMemory: await readMemoryText(projectId) }, layout, chapters: numbered };
}

export type Book = NonNullable<Awaited<ReturnType<typeof loadBook>>>;
export type BookChapter = Book["chapters"][number];
export type BookSection = BookChapter["sections"][number];

/** 읽는 순서대로 모든 절 */
export function flatSections<B extends { chapters: { sections: unknown[] }[] } = Book>(book: B) {
  type C = B["chapters"][number];
  return book.chapters.flatMap((c) => c.sections.map((s) => ({ chapter: c as C, section: s as C["sections"][number] })));
}

/**
 * 본문(content) 없이 책 구조만 — 목차·절 정보·요약만 필요한 AI 작업(집필 준비·목차 설계·장 퇴고)용.
 * 절 본문(Tiptap JSON)은 책 전체에서 가장 큰 부분이라 필요한 절만 fillContent()로 그때 읽는다.
 * 절의 content는 읽기 전에는 undefined다.
 */
export async function loadBookOutline(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      chapters: { orderBy: { order: "asc" }, include: { sections: { orderBy: { order: "asc" }, omit: { content: true } } } },
      glossary: true,
    },
  });
  if (!project) return null;
  const layout = parseLayout(project.layout);
  const chapters = project.chapters.map((c) => ({ ...c, sections: c.sections.map((s) => ({ ...s, content: undefined as string | undefined })) }));
  // 책의 기억(작가가 확정한 사항) — 집필·퇴고·일관성 프롬프트에 짧은 블록으로 들어간다
  return { project: { ...project, bookMemory: await readMemoryText(projectId) }, layout, chapters: numberChapters(chapters, layout.numberFormat) };
}

export type BookOutline = NonNullable<Awaited<ReturnType<typeof loadBookOutline>>>;

/** 아직 읽지 않은 절 본문만 한 번에 읽어 채운다 (객체를 그대로 고친다) */
export async function fillContent(sections: { id: string; content?: string }[]) {
  const need = sections.filter((s) => s.content === undefined);
  if (!need.length) return;
  const rows = await prisma.section.findMany({ where: { id: { in: need.map((s) => s.id) } }, select: { id: true, content: true } });
  const byId = new Map(rows.map((r) => [r.id, r.content]));
  for (const s of need) s.content = byId.get(s.id) ?? "";
}
