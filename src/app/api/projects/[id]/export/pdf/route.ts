import { loadBook } from "@/lib/book";
import { fail, handle } from "@/lib/api";
import { preflight } from "@/lib/export/preflight";
import { renderPdf } from "@/lib/export/pdf";
import { deliverFile } from "@/lib/deliver";

export const maxDuration = 300;

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/export/pdf">) => {
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
  const book = await loadBook(id);
  if (!book) return fail("프로젝트를 찾을 수 없습니다.", 404);
  const size = b.size === "trim" ? "trim" : "bleed";
  const errors = (await preflight(book, size)).filter((i) => i.level === "error");
  if (errors.length) return fail("출력할 수 없습니다:\n" + errors.map((e) => "· " + e.message).join("\n"));

  // 조판 페이지를 여는 주소: 설정값 → 공개 주소 → 이 요청의 주소
  const origin = new URL(process.env.INTERNAL_APP_URL || process.env.APP_ORIGIN || new URL(req.url).origin).origin;
  const q = new URLSearchParams({ mode: "print", size });
  if (b.scope === "chapter" && b.targetId) q.set("scope", "chapter"), q.set("cid", b.targetId);
  if (b.scope === "section" && b.targetId) q.set("scope", "section"), q.set("sid", b.targetId);
  if (b.padEven) q.set("padEven", "1");
  const { pdf, check } = await renderPdf(`${origin}/book/${id}?${q}`);
  return deliverFile(pdf, `${book.project.title}_${size === "trim" ? "148x210" : "154x216"}.pdf`, "application/pdf", { check });
});
