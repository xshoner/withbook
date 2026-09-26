import { fail, handle } from "@/lib/api";
import { deliverFile } from "@/lib/deliver";
import { renderPdf } from "@/lib/export/pdf";
import { loadCover } from "@/lib/cover/store";
import { coverIssues, coverLayout } from "@/lib/cover/spec";
import { prisma } from "@/lib/db";

export const maxDuration = 300;

/** 표지 PDF — 저장된 디자인을 /cover/{id}로 조판해 재단 여백 포함 크기로 인쇄한다 (TrimBox·BleedBox 포함) */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/cover/export">) => {
  const { id } = await ctx.params;
  const { design, saved } = await loadCover(id);
  if (!saved) return fail("먼저 표지를 저장하세요.");
  const errors = coverIssues(design).filter((i) => i.level === "error");
  if (errors.length) return fail("출력할 수 없습니다:\n" + errors.map((e) => "· " + e.message).join("\n"));
  const l = coverLayout(design);
  const p = await prisma.project.findUnique({ where: { id }, select: { title: true } });
  const origin = new URL(process.env.INTERNAL_APP_URL || process.env.APP_ORIGIN || new URL(req.url).origin).origin;
  const { pdf, check } = await renderPdf(`${origin}/cover/${id}`, {
    projectId: id,
    sheet: { widthMm: l.sheetW, heightMm: l.sheetH, bleedMm: l.bleed },
    extraOrigins: ["https://fonts.googleapis.com", "https://fonts.gstatic.com"],
  });
  const mm = (n: number) => String(Math.round(n * 10) / 10);
  return deliverFile(pdf, `${p?.title ?? "표지"}_표지_${mm(l.sheetW)}x${mm(l.sheetH)}mm.pdf`, "application/pdf", { check });
});
