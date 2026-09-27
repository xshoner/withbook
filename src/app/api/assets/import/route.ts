import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { MAX_ASSET_BYTES, saveProjectImage } from "@/lib/assets";
import { commonsDownloadAllowed, downloadCommons } from "@/lib/images/commons";

export const maxDuration = 60;

/**
 * 추천 이미지 가져오기 — 서버가 Wikimedia Commons(upload.wikimedia.org)에서 내려받아 원고 이미지로 저장한다.
 * POST { projectId, url, title } → 올린 이미지와 같은 { id, src, widthPx, heightPx, filename }
 */
export const POST = handle(async (req: Request) => {
  const b = await req.json();
  const projectId = String(b.projectId ?? "");
  const url = String(b.url ?? "");
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) return fail("책 ID가 올바르지 않습니다.");
  if (!commonsDownloadAllowed(url)) return fail("가져올 수 없는 이미지 주소입니다.");
  if (!(await prisma.project.findFirst({ where: { id: projectId, deletedAt: null }, select: { id: true } }))) return fail("책이 없습니다.", 404);
  const buffer = await downloadCommons(url, MAX_ASSET_BYTES);
  const name = String(b.title ?? "").replace(/[\/:*?"<>|\x00-\x1f]/g, "").trim().slice(0, 80) || "commons-image";
  return ok(await saveProjectImage(projectId, buffer, name));
});
