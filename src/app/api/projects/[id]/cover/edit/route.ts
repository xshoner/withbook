import sharp from "sharp";
import { fail, handle, ok } from "@/lib/api";
import { editImage } from "@/lib/ai/image";
import { printJpeg, readProjectAsset, storeCoverImage } from "@/lib/cover/image-store";
import { type Rect, type Region, buildEditPrompt, coverLayout, editFrame, maskFraction, normalizeCover, regionBox, requestSize } from "@/lib/cover/spec";

export const maxDuration = 300;

const REGIONS: Region[] = ["full", "backFlap", "back", "spine", "front", "frontFlap"];

/**
 * [그림 수정] — 지금 영역의 그림을 수정 프롬프트대로 고친다 (처음부터 다시 만들지 않는다).
 * rect(펼침면 mm)가 있으면 그 부분만 바꾸도록 마스크를 보낸다.
 * 결과는 원본과 같은 픽셀 크기로 저장해 편집기의 위치·확대 설정이 그대로 맞는다.
 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/cover/edit">) => {
  const { id } = await ctx.params;
  const b = await req.json();
  const region: Region = REGIONS.includes(b.region) ? b.region : "full";
  const request = typeof b.prompt === "string" ? b.prompt.trim().slice(0, 4000) : "";
  if (!request) return fail("무엇을 고칠지 수정 요청을 입력하세요.");
  const design = normalizeCover(b.design);
  const img = design.images[region];
  if (!img) return fail("이 영역에 고칠 그림이 없습니다. 먼저 AI 제작하거나 그림을 올리세요.");
  const l = coverLayout(design);
  const box = regionBox(l, region);
  const r = b.rect && [b.rect.x, b.rect.y, b.rect.w, b.rect.h].every((v: unknown) => Number.isFinite(Number(v))) ? (b.rect as Rect) : null;
  const frac = r ? maskFraction(img, box, r) : null;
  if (r && !frac) return fail("지정한 부분이 그림 밖에 있습니다. 그림 위에서 다시 지정하세요.");

  const src = await readProjectAsset(id, img.assetId);
  const iw = src.widthPx;
  const ih = src.heightPx;
  const size = requestSize({ w: iw, h: ih }, design.ai.requestSize);
  const fallbackSize = iw >= ih ? "1536x1024" : "1024x1536";

  /** 요청 크기에 원본 비율 그대로 넣고 남는 곳은 가장자리를 비춰 채운다. 마스크는 지정 부분만 투명 */
  const prepare = async (sz: string) => {
    const f = editFrame(sz, iw, ih);
    const image = await sharp(src.buffer, { limitInputPixels: 100_000_000 })
      .resize(f.cw, f.ch, { fit: "fill", kernel: "lanczos3" })
      .extend({ left: f.ox, top: f.oy, right: f.RW - f.cw - f.ox, bottom: f.RH - f.ch - f.oy, extendWith: "mirror" })
      .png()
      .toBuffer();
    if (!frac) return { image };
    const hole = {
      left: f.ox + Math.floor(frac.x * f.cw),
      top: f.oy + Math.floor(frac.y * f.ch),
      width: Math.max(1, Math.ceil(frac.w * f.cw)),
      height: Math.max(1, Math.ceil(frac.h * f.ch)),
    };
    // 불투명한 검정 바탕에 지정한 부분만 투명(알파 0) — 픽셀을 직접 채운다
    const px = Buffer.alloc(f.RW * f.RH * 4);
    for (let i = 3; i < px.length; i += 4) px[i] = 255;
    const x1 = Math.min(f.RW, hole.left + hole.width);
    const y1 = Math.min(f.RH, hole.top + hole.height);
    for (let y = hole.top; y < y1; y++) for (let x = hole.left; x < x1; x++) px[(y * f.RW + x) * 4 + 3] = 0;
    const mask = await sharp(px, { raw: { width: f.RW, height: f.RH, channels: 4 } }).png().toBuffer();
    return { image, mask };
  };

  const gen = await editImage({ prompt: buildEditPrompt(design, region, request, Boolean(frac)), size, fallbackSize, projectId: id, signal: req.signal, edit: { prepare } });

  // 받은 그림을 요청 크기로 맞춘 뒤 원본 자리만 잘라 원본 크기로 되돌린다
  const f = editFrame(gen.size, iw, ih);
  const meta = await sharp(gen.buffer).metadata();
  const framed = await sharp(gen.buffer, { limitInputPixels: 100_000_000 }).resize(f.RW, f.RH, { fit: "fill" }).extract({ left: f.ox, top: f.oy, width: f.cw, height: f.ch }).toBuffer();
  const out = await printJpeg(sharp(framed).resize(iw, ih, { fit: "fill", kernel: "lanczos3" }), design.bgColor);
  const saved = await storeCoverImage(id, out, iw, ih, region, true);
  return ok({ ...saved, spineMm: l.spine, model: gen.model, requested: gen.size, masked: Boolean(frac), native: { width: meta.width ?? 0, height: meta.height ?? 0 } });
});
