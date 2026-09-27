import { loadBook } from "@/lib/book";
import { fail, handle } from "@/lib/api";
import { preflight } from "@/lib/export/preflight";
import { renderPdf } from "@/lib/export/pdf";
import { deliverFile } from "@/lib/deliver";
import { savePageCount, savePdfCheck } from "@/lib/print/page-count";

export const maxDuration = 300;

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/export/pdf">) => {
  const { id } = await ctx.params;
  const b = await req.json().catch(() => ({}));
  const book = await loadBook(id);
  if (!book) return fail("책을 찾을 수 없습니다.", 404);
  const size = b.size === "trim" ? "trim" : "bleed";
  const errors = (await preflight(book, size)).filter((i) => i.level === "error");
  if (errors.length) return fail("출력할 수 없습니다:\n" + errors.map((e) => "· " + e.message).join("\n"));

  // 조판 페이지를 여는 주소: 설정값 → 공개 주소 → 이 요청의 주소
  const origin = new URL(process.env.INTERNAL_APP_URL || process.env.APP_ORIGIN || new URL(req.url).origin).origin;
  const q = new URLSearchParams({ mode: "print", size });
  if (b.scope === "chapter" && b.targetId) q.set("scope", "chapter"), q.set("cid", b.targetId);
  if (b.scope === "section" && b.targetId) q.set("scope", "section"), q.set("sid", b.targetId);
  if (b.padEven) q.set("padEven", "1");
  // 조판 시간 초과는 PdfTimeoutError(504, 한국어 안내)로 handle()이 그대로 전달한다
  // 시간 예산은 이 요청이 시작된 때부터 잰다(책 불러오기·사전 점검 포함) — renderPdf가 요청 문맥에서 읽는다
  const { pdf, check } = await renderPdf(`${origin}/book/${id}?${q}`, { projectId: id });
  // 책 전체를 뽑았으면 실제 쪽수로 기록한다 — 표지 책등 폭의 기준 (실패해도 PDF는 준다)
  if (!q.has("scope")) {
    await savePageCount(id, check.pages, "pdf").catch((e) => console.warn("[page-count] 기록 실패", e?.message));
    // 제출 전 점검이 쓰는 마지막 전체 PDF 점검 결과(판형·글꼴 임베딩·쪽수)
    await savePdfCheck(id, { ...check, size, padEven: !!b.padEven }).catch((e) => console.warn("[pdf-check] 기록 실패", e?.message));
  }
  return deliverFile(pdf, `${book.project.title}_${size === "trim" ? "148x210" : "154x216"}.pdf`, "application/pdf", { check });
});
