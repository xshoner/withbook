import { loadBook } from "@/lib/book";
import { fail, handle } from "@/lib/api";
import { deliverFile } from "@/lib/deliver";
import { buildEpub } from "@/lib/export/epub";
import { readBackMatter } from "@/lib/back-matter-store";

export const maxDuration = 300;

export const POST = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/export/epub">) => {
  const { id } = await ctx.params;
  const book = await loadBook(id);
  if (!book) return fail("책을 찾을 수 없습니다.", 404);
  const buf = await buildEpub(book, { biblio: (await readBackMatter(id)).biblio });
  return deliverFile(buf, `${book.project.title}.epub`, "application/epub+zip");
});
