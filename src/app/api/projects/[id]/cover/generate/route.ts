import sharp from "sharp";
import { fail, handle, ok } from "@/lib/api";
import { prisma } from "@/lib/db";
import { assetKey } from "@/lib/backup";
import { putObject } from "@/lib/storage";
import { generateImage } from "@/lib/ai/image";
import { addCoverHistory } from "@/lib/cover/store";
import { type Region, buildImagePrompt, coverLayout, normalizeCover, pxAt300, regionBox, requestSize } from "@/lib/cover/spec";

export const maxDuration = 300;

const REGIONS: Region[] = ["full", "backFlap", "back", "spine", "front", "frontFlap"];

/**
 * [AI 제작] — 편집 중인 디자인(저장 전 값 포함)으로 프롬프트를 만들어 그림을 생성하고,
 * 영역 비율로 맞춘 뒤 300 DPI 인쇄 크기로 키워 이 책의 이미지로 저장한다.
 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/cover/generate">) => {
  const { id } = await ctx.params;
  const b = await req.json();
  const region: Region = REGIONS.includes(b.region) ? b.region : "full";
  const design = normalizeCover(b.design);
  const project = await prisma.project.findFirst({
    where: { id, deletedAt: null },
    select: { title: true, subtitle: true, author: true, topic: true, keyMessage: true, audience: true, tone: true, chapters: { where: { kind: "body" }, orderBy: { order: "asc" }, select: { title: true } } },
  });
  if (!project) return fail("프로젝트를 찾을 수 없습니다.", 404);

  const l = coverLayout(design);
  const box = regionBox(l, region);
  if (box.w <= 0) return fail("이 영역이 없습니다 (날개 설정을 확인하세요).");
  const prompt = buildImagePrompt(design, { ...project, chapters: project.chapters.map((c) => c.title) }, region);
  const size = requestSize(box, design.ai.requestSize);
  const fallbackSize = box.w >= box.h ? "1536x1024" : "1024x1536";
  const gen = await generateImage({ prompt, size, fallbackSize, projectId: id, signal: req.signal });

  // 영역 비율로 가운데를 맞춰 자르고 300 DPI 크기로 키운다 (모델 출력은 인쇄 해상도보다 작다)
  const src = sharp(gen.buffer, { limitInputPixels: 100_000_000 });
  const meta = await src.metadata();
  const W = pxAt300(box.w);
  const H = pxAt300(box.h);
  const out = await src
    .resize(W, H, { fit: "cover", position: "centre", kernel: "lanczos3" })
    .flatten({ background: design.bgColor })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true })
    .withMetadata({ density: 300 })
    .toBuffer();

  const a = await prisma.asset.create({ data: { projectId: id, filename: `cover-ai-${region}.jpg`, mime: "image/jpeg", widthPx: W, heightPx: H, path: "" } });
  const key = assetKey(id, a.id, ".jpg");
  try {
    await putObject("assets", key, out, "image/jpeg");
  } catch (e) {
    await prisma.asset.delete({ where: { id: a.id } });
    throw e;
  }
  await prisma.asset.update({ where: { id: a.id }, data: { path: key } });
  const item = { assetId: a.id, widthPx: W, heightPx: H, region, at: new Date().toISOString() };
  const history = await addCoverHistory(id, item);
  return ok({
    ...item,
    src: `/api/assets/${a.id}`,
    spineMm: l.spine,
    model: gen.model,
    requested: gen.size,
    native: { width: meta.width ?? 0, height: meta.height ?? 0 },
    history,
  });
});
