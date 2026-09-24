import "server-only";
import { prisma } from "./db";
import { chapterLabel, parseLayout, sectionLabel } from "./layout";

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
  // 앞붙이 → 본문 → 뒷붙이 순서로 정렬, 본문 장에만 번호
  const kindOrder: Record<string, number> = { front: 0, body: 1, back: 2 };
  const chapters = [...project.chapters].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.order - b.order);
  let n = 0;
  const numbered = chapters.map((c) => {
    const no = c.kind === "body" ? ++n : 0;
    return {
      ...c,
      no,
      label: no ? chapterLabel(layout.numberFormat, no) : "",
      sections: c.sections.map((s, i) => ({
        ...s,
        no: i + 1,
        label: no ? sectionLabel(layout.numberFormat, no, i + 1) : "",
      })),
    };
  });
  return { project, layout, chapters: numbered };
}

export type Book = NonNullable<Awaited<ReturnType<typeof loadBook>>>;
export type BookChapter = Book["chapters"][number];
export type BookSection = BookChapter["sections"][number];

/** 읽는 순서대로 모든 절 */
export function flatSections(book: Book) {
  return book.chapters.flatMap((c) => c.sections.map((s) => ({ chapter: c, section: s })));
}
