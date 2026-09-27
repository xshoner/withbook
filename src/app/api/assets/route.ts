import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { assetKey } from "@/lib/maintenance";
import { prepareImage } from "@/lib/imageSize";
import { putObject } from "@/lib/storage";
import { readUpload } from "@/lib/uploads";

const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
// 원고 이미지 한 장 최대 크기 (백업 복원의 이미지 한도와 같다)
const MAX_BYTES = 20 * 1024 * 1024;
const tooLarge = () => Object.assign(new Error("이미지 파일은 20MB 이하로 올려주세요."), { status: 413 });

export const POST = handle(async (req: Request) => {
  const form = await req.formData();
  const projectId = String(form.get("projectId") ?? "");
  if (!projectId) return fail("프로젝트가 없습니다.");
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) return fail("프로젝트 ID가 올바르지 않습니다.");
  const file = await readUpload(form, "file", MAX_BYTES).catch((e) => {
    throw e?.status === 413 ? tooLarge() : e;
  });
  if (!file) return fail("파일이 없습니다.");
  if (file.buffer.length > MAX_BYTES) throw tooLarge();
  if (!await prisma.project.findFirst({ where: { id: projectId, deletedAt: null }, select: { id: true } })) return fail("프로젝트가 없습니다.", 404);
  // EXIF 방향 반영·긴 변 3,200px 초과분만 축소·WEBP→PNG/JPEG (큰 파일이 incoming 버킷을 거쳐 온 경우도 같다)
  const size = await prepareImage(file.buffer).catch((e) => {
    console.warn("[assets] 이미지 처리 실패", e?.message);
    return null;
  });
  if (!size) return fail("JPG, PNG, WEBP 이미지만 넣을 수 있습니다(파일이 손상되었을 수 있습니다).");
  if (size.width <= 0 || size.height <= 0 || size.width * size.height > 100_000_000) return fail("이미지 크기가 허용 범위를 벗어났습니다.");
  const filename = file.name.replace(/\.webp$/i, EXT[size.mime]);
  const a = await prisma.asset.create({
    data: { projectId, filename, mime: size.mime, widthPx: size.width, heightPx: size.height, path: "" },
  });
  const key = assetKey(projectId, a.id, EXT[size.mime]);
  try {
    await putObject("assets", key, size.buffer, size.mime);
  } catch (e) {
    await prisma.asset.delete({ where: { id: a.id } });
    throw e;
  }
  await prisma.asset.update({ where: { id: a.id }, data: { path: key } });
  return ok({ id: a.id, src: `/api/assets/${a.id}`, widthPx: size.width, heightPx: size.height, filename });
});
