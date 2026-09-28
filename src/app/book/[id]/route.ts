import { loadBook } from "@/lib/book";
import { bookHtml, type BookHtmlOptions } from "@/lib/print/bookHtml";
import { checkAccess } from "@/lib/security";
import { readBackMatter } from "@/lib/back-matter-store";

/** Paged.js 조판용 책 HTML — 미리보기(iframe)·측정·PDF 공용 */
export async function GET(req: Request, ctx: RouteContext<"/book/[id]">) {
  const denied = checkAccess(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const book = await loadBook(id);
  if (!book) return new Response("not found", { status: 404 });
  const scopeKind = q.get("scope");
  const scope: BookHtmlOptions["scope"] =
    scopeKind === "chapter" && q.get("cid")
      ? { kind: "chapter", id: q.get("cid")! }
      : scopeKind === "section" && q.get("sid")
        ? { kind: "section", id: q.get("sid")! }
        : { kind: "all" };
  // 참고문헌·찾아보기는 책 전체 조판에만 (쪽수 측정·PDF·미리보기가 같은 쪽수를 갖게)
  const backMatter = scope.kind === "all" ? await readBackMatter(id) : undefined;
  const html = bookHtml(book, {
    backMatter,
    mode: (["preview", "print", "measure"].includes(q.get("mode") ?? "") ? q.get("mode") : "preview") as BookHtmlOptions["mode"],
    size: q.get("size") === "trim" ? "trim" : "bleed",
    scope,
    focus: q.get("focus") ?? undefined,
    padEven: q.get("padEven") === "1",
    view: q.get("view") === "single" ? "single" : "spread",
    guides: { trim: q.get("gTrim") === "1", safe: q.get("gSafe") === "1", body: q.get("gBody") === "1" },
  });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
