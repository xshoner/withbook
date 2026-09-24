import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { assetKey } from "@/lib/backup";
import { imageSize } from "@/lib/imageSize";
import { putObject } from "@/lib/storage";
import { readUpload } from "@/lib/uploads";

const EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

export const POST = handle(async (req: Request) => {
  const form = await req.formData();
  const projectId = String(form.get("projectId") ?? "");
  if (!projectId) return fail("프로젝트가 없습니다.");
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) return fail("프로젝트 ID가 올바르지 않습니다.");
  const file = await readUpload(form, "file", 20 * 1024 * 1024);
  if (!file) return fail("파일이 없습니다.");
  if (!await prisma.project.findFirst({ where: { id: projectId, deletedAt: null }, select: { id: true } })) return fail("프로젝트가 없습니다.", 404);
  const size = imageSize(file.buffer);
  if (!size) return fail("JPG, PNG, WEBP 이미지만 넣을 수 있습니다.");
  if (size.width <= 0 || size.height <= 0 || size.width * size.height > 100_000_000) return fail("이미지 크기가 허용 범위를 벗어났습니다.");
  const a = await prisma.asset.create({
    data: { projectId, filename: file.name, mime: size.mime, widthPx: size.width, heightPx: size.height, path: "" },
  });
  const key = assetKey(projectId, a.id, EXT[size.mime]);
  try {
    await putObject("assets", key, file.buffer, size.mime);
  } catch (e) {
    await prisma.asset.delete({ where: { id: a.id } });
    throw e;
  }
  await prisma.asset.update({ where: { id: a.id }, data: { path: key } });
  return ok({ id: a.id, src: `/api/assets/${a.id}`, widthPx: size.width, heightPx: size.height, filename: file.name });
});
