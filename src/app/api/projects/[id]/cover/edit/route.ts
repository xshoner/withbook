import sharp from "sharp";
import { fail, handle, ok } from "@/lib/api";
import { editImage } from "@/lib/ai/image";
import { printJpeg, readProjectAsset, storeCoverImage } from "@/lib/cover/image-store";
import { type Rect, type Region, buildEditPrompt, coverLayout, editCrop, editFrame, featherAlpha, maskFraction, placeImage, PRINT_DPI, AI_DPI, normalizeCover, regionBox, requestSize } from "@/lib/cover/spec";

export const maxDuration = 300;

const REGIONS: Region[] = ["full", "backFlap", "back", "spine", "front", "frontFlap"];
const LIMIT = { limitInputPixels: 200_000_000 };

/**
 * [그림 수정] — 지금 영역의 그림을 수정 프롬프트대로 고친다 (처음부터 다시 만들지 않는다).
 * rect(펼침면 mm)가 있으면 그 둘레만 잘라 크게 보내고(마스크 = 지정 부분 + 녹이는 띠),
 * 받은 그림에서 지정 부분만 경계를 부드럽게 녹여 원본에 다시 붙인다 — 지정 밖은 한 픽셀도 바뀌지 않고 사각형 자국이 남지 않는다.
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
  // 저장된 크기 대신 실제 픽셀 크기로 (붙여 넣을 때 어긋나지 않게)
  const m0 = await sharp(src.buffer, LIMIT).metadata();
  let iw = m0.width ?? src.widthPx;
  let ih = m0.height ?? src.heightPx;
  // 원본이 지금 배치에서 300 DPI보다 낮으면 먼저 AI_DPI 크기로 키운다 (고친 그림도 인쇄 해상도를 지키게)
  const at = placeImage({ ...img, widthPx: iw, heightPx: ih }, box);
  const dpiNow = iw / (at.w / 25.4);
  const k = dpiNow < PRINT_DPI ? AI_DPI / dpiNow : 1;
  if (k > 1 && iw * ih * k * k <= 100_000_000) {
    iw = Math.ceil(iw * k);
    ih = Math.ceil(ih * k);
    src.buffer = await sharp(src.buffer, LIMIT).resize(iw, ih, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
  }
  const part = frac ? editCrop(iw, ih, frac) : null;
  // 모델에 보낼 그림: 부분 수정이면 지정 둘레만, 아니면 전체
  const crop = part?.crop ?? { left: 0, top: 0, width: iw, height: ih };
  const cropBuf = part ? await sharp(src.buffer, LIMIT).extract(crop).png().toBuffer() : src.buffer;
  const size = requestSize({ w: crop.width, h: crop.height }, design.ai.requestSize);
  const fallbackSize = crop.width >= crop.height ? "1536x1024" : "1024x1536";

  /** 요청 크기에 잘라 낸 그림을 비율 그대로 넣고 남는 곳은 가장자리를 비춰 채운다. 마스크는 지정 부분(+녹이는 띠)만 투명 */
  const prepare = async (sz: string) => {
    const f = editFrame(sz, crop.width, crop.height);
    const image = await sharp(cropBuf, LIMIT)
      .resize(f.cw, f.ch, { fit: "fill", kernel: "lanczos3" })
      .extend({ left: f.ox, top: f.oy, right: f.RW - f.cw - f.ox, bottom: f.RH - f.ch - f.oy, extendWith: "mirror" })
      .png()
      .toBuffer();
    if (!part) return { image };
    const sx = f.cw / crop.width;
    const sy = f.ch / crop.height;
    const hole = {
      left: f.ox + Math.floor((part.hole.left - crop.left) * sx),
      top: f.oy + Math.floor((part.hole.top - crop.top) * sy),
      width: Math.max(1, Math.ceil(part.hole.width * sx)),
      height: Math.max(1, Math.ceil(part.hole.height * sy)),
    };
    // 불투명한 검정 바탕에 지정 부분 + 녹이는 띠만 투명(알파 0)
    const grow = Math.ceil(part.feather * Math.max(sx, sy));
    const a = featherAlpha(f.RW, f.RH, hole, 1, grow);
    const px = Buffer.alloc(f.RW * f.RH * 4);
    for (let i = 0; i < a.length; i++) px[i * 4 + 3] = a[i] ? 0 : 255;
    const mask = await sharp(px, { raw: { width: f.RW, height: f.RH, channels: 4 } }).png().toBuffer();
    return { image, mask };
  };

  const gen = await editImage({ prompt: buildEditPrompt(design, region, request, Boolean(part)), size, fallbackSize, projectId: id, signal: req.signal, edit: { prepare } });

  // 받은 그림을 요청 크기로 맞춘 뒤 잘라 보낸 자리만 꺼내 원래 크기로 되돌린다
  const f = editFrame(gen.size, crop.width, crop.height);
  const meta = await sharp(gen.buffer).metadata();
  const framed = await sharp(gen.buffer, LIMIT).resize(f.RW, f.RH, { fit: "fill" }).extract({ left: f.ox, top: f.oy, width: f.cw, height: f.ch }).toBuffer();
  const back = sharp(framed, LIMIT).resize(crop.width, crop.height, { fit: "fill", kernel: "lanczos3" });
  let out: Buffer;
  if (part) {
    // 지정 부분만, 경계는 feather 폭으로 녹여 원본 위에 붙인다
    const local = { ...part.hole, left: part.hole.left - crop.left, top: part.hole.top - crop.top };
    const alpha = Buffer.from(featherAlpha(crop.width, crop.height, local, part.feather));
    const patch = await back.removeAlpha().joinChannel(alpha, { raw: { width: crop.width, height: crop.height, channels: 1 } }).png().toBuffer();
    out = await printJpeg(sharp(src.buffer, LIMIT).composite([{ input: patch, left: crop.left, top: crop.top }]), design.bgColor);
  } else {
    out = await printJpeg(back, design.bgColor);
  }
  const saved = await storeCoverImage(id, out, iw, ih, region, true);
  return ok({ ...saved, spineMm: l.spine, model: gen.model, requested: gen.size, masked: Boolean(part), native: { width: meta.width ?? 0, height: meta.height ?? 0 } });
});
