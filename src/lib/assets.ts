import "server-only";
import { prisma } from "./db";
import { assetKey } from "./maintenance";
import { prepareImage } from "./imageSize";
import { putObject } from "./storage";

const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

/** 원고 이미지 한 장 최대 크기 (백업 복원의 이미지 한도와 같다) */
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;

export type SavedAsset = { id: string; src: string; widthPx: number; heightPx: number; filename: string };

/**
 * 원고 이미지 저장 — 올린 파일·추천 이미지 가져오기가 같이 쓴다.
 * EXIF 방향 반영·긴 변 3,200px 초과분만 축소·WEBP→PNG/JPEG. 문제가 있으면 status 400 오류를 던진다.
 */
export async function saveProjectImage(projectId: string, buffer: Buffer, name: string): Promise<SavedAsset> {
  const bad = (m: string) => Object.assign(new Error(m), { status: 400 });
  const size = await prepareImage(buffer).catch((e) => {
    console.warn("[assets] 이미지 처리 실패", e?.message);
    return null;
  });
  if (!size) throw bad("JPG, PNG, WEBP 이미지만 넣을 수 있습니다(파일이 손상되었을 수 있습니다).");
  if (size.width <= 0 || size.height <= 0 || size.width * size.height > 100_000_000) throw bad("이미지 크기가 허용 범위를 벗어났습니다.");
  const ext = EXT[size.mime];
  const filename = /\.(png|jpe?g|webp)$/i.test(name) ? name.replace(/\.(png|jpe?g|webp)$/i, ext) : name + ext;
  const a = await prisma.asset.create({
    data: { projectId, filename, mime: size.mime, widthPx: size.width, heightPx: size.height, path: "" },
  });
  const key = assetKey(projectId, a.id, ext);
  try {
    await putObject("assets", key, size.buffer, size.mime);
  } catch (e) {
    await prisma.asset.delete({ where: { id: a.id } });
    throw e;
  }
  await prisma.asset.update({ where: { id: a.id }, data: { path: key } });
  return { id: a.id, src: `/api/assets/${a.id}`, widthPx: size.width, heightPx: size.height, filename };
}
