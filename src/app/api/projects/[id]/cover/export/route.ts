import { fail, handle } from "@/lib/api";
import { deliverFile } from "@/lib/deliver";
import sharp from "sharp";
import { renderImage, renderPdf } from "@/lib/export/pdf";
import { printJpeg } from "@/lib/cover/image-store";
import { loadCover } from "@/lib/cover/store";
import { PRINT_DPI, coverIssues, coverLayout } from "@/lib/cover/spec";
import { prisma } from "@/lib/db";

export const maxDuration = 300;

/** 표지 PDF·JPG(300 DPI, body.format === "jpg") — 저장된 디자인을 /cover/{id}로 조판해 재단 여백 포함 크기로 인쇄한다 (TrimBox·BleedBox 포함) */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/cover/export">) => {
  const { id } = await ctx.params;
  // 쪽수를 직접 고치지 않았으면 loadCover가 실제 조판 쪽수로 맞춘 디자인을 준다 (/cover/{id} 조판 페이지도 같다)
  const { design, saved, actualPages } = await loadCover(id);
  if (!saved) return fail("먼저 표지를 저장하세요.");
  const errors = coverIssues(design, { actualPages }).filter((i) => i.level === "error");
  if (errors.length) return fail("출력할 수 없습니다:\n" + errors.map((e) => "· " + e.message).join("\n"));
  const l = coverLayout(design);
  const p = await prisma.project.findUnique({ where: { id }, select: { title: true } });
  const origin = new URL(process.env.INTERNAL_APP_URL || process.env.APP_ORIGIN || new URL(req.url).origin).origin;
  const opts = {
    projectId: id,
    sheet: { widthMm: l.sheetW, heightMm: l.sheetH, bleedMm: l.bleed },
    extraOrigins: ["https://fonts.googleapis.com", "https://fonts.gstatic.com"],
  };
  const mm = (n: number) => String(Math.round(n * 10) / 10);
  const body = await req.json().catch(() => ({}));
  if (body?.format === "jpg") {
    const png = await renderImage(`${origin}/cover/${id}`, { ...opts, dpi: PRINT_DPI });
    const jpg = await printJpeg(sharp(png, { limitInputPixels: 200_000_000 }), "#ffffff");
    const { width, height } = await sharp(jpg).metadata();
    return deliverFile(jpg, `${p?.title ?? "표지"}_표지_${mm(l.sheetW)}x${mm(l.sheetH)}mm_${PRINT_DPI}dpi.jpg`, "image/jpeg", { image: { width, height, dpi: PRINT_DPI } });
  }
  const { pdf, check } = await renderPdf(`${origin}/cover/${id}`, opts);
  return deliverFile(pdf, `${p?.title ?? "표지"}_표지_${mm(l.sheetW)}x${mm(l.sheetH)}mm.pdf`, "application/pdf", { check });
});
