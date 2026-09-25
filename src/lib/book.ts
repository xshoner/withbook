import "server-only";
import { prisma } from "./db";
import { numberChapters, parseLayout } from "./layout";

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
  return { project, layout, chapters: numbered };
}

export type Book = NonNullable<Awaited<ReturnType<typeof loadBook>>>;
export type BookChapter = Book["chapters"][number];
export type BookSection = BookChapter["sections"][number];

/** 읽는 순서대로 모든 절 */
export function flatSections(book: Book) {
  return book.chapters.flatMap((c) => c.sections.map((s) => ({ chapter: c, section: s })));
}
