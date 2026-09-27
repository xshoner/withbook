import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { MAX_ASSET_BYTES, saveProjectImage } from "@/lib/assets";
import { readUpload } from "@/lib/uploads";

const tooLarge = () => Object.assign(new Error("이미지 파일은 20MB 이하로 올려주세요."), { status: 413 });

export const POST = handle(async (req: Request) => {
  const form = await req.formData();
  const projectId = String(form.get("projectId") ?? "");
  if (!projectId) return fail("책이 없습니다.");
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) return fail("책 ID가 올바르지 않습니다.");
  const file = await readUpload(form, "file", MAX_ASSET_BYTES).catch((e) => {
    throw e?.status === 413 ? tooLarge() : e;
  });
  if (!file) return fail("파일이 없습니다.");
  if (file.buffer.length > MAX_ASSET_BYTES) throw tooLarge();
  if (!await prisma.project.findFirst({ where: { id: projectId, deletedAt: null }, select: { id: true } })) return fail("책이 없습니다.", 404);
  // 큰 파일이 incoming 버킷을 거쳐 온 경우도 같다
  return ok(await saveProjectImage(projectId, file.buffer, file.name));
});
