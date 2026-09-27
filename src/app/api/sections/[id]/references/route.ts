import path from "node:path";
import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { readUpload } from "@/lib/uploads";
import { extractText } from "@/lib/style/reference";
import { REF_EXT, REF_MAX_BYTES } from "@/lib/ai/section-refs";
import { addRef, deleteRef, listRefs } from "@/lib/section-refs-store";

export const maxDuration = 60;

/**
 * 절 참고 자료 — 집필(새로 쓰기·이어쓰기·새 버전)이 근거로 쓰고, 자료에서 가져온 사실에는 출처 각주를 단다.
 *   GET                                   → { items: [{ id, name, chars, createdAt }] }
 *   POST multipart file (txt·md·pdf·docx·hwpx, 10MB, 큰 파일은 incoming 업로드 경로 filePath+fileName)
 *        또는 JSON { name, text }         → { item, truncated }  (글은 6만 자까지 보관)
 *   DELETE ?refId=                        → { ok }
 */

async function ensureSection(id: string) {
  const s = await prisma.section.findUnique({ where: { id }, select: { id: true } });
  if (!s) throw Object.assign(new Error("절을 찾을 수 없습니다."), { status: 404 });
}

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/sections/[id]/references">) => {
  const { id } = await ctx.params;
  await ensureSection(id);
  return ok({ items: await listRefs(id) });
});

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/references">) => {
  const { id } = await ctx.params;
  await ensureSection(id);
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = await readUpload(form, "file", REF_MAX_BYTES).catch((e) => {
      if (e?.status === 413) throw Object.assign(new Error(`참고 자료 파일은 ${REF_MAX_BYTES / 1024 / 1024}MB 이하로 올려주세요.`), { status: 413 });
      throw e;
    });
    if (!file) return fail("파일이 없습니다.");
    const ext = path.extname(file.name).toLowerCase();
    if (!REF_EXT.includes(ext)) return fail("txt·md·pdf·docx·hwpx 파일만 올릴 수 있습니다.");
    let text = "";
    try {
      text = await extractText(file.name, file.buffer, { keepAll: true });
    } catch (e: any) {
      console.warn("[refs] 글 뽑기 실패", file.name, e?.message);
      return fail("파일에서 글을 읽지 못했습니다. 파일이 손상되었거나 암호가 걸려 있는지 확인하세요.");
    }
    const name = String(form.get("name") ?? "").trim() || file.name.replace(/\.[^.]+$/, "");
    return ok(await addRef(id, name, text));
  }
  const b = await req.json();
  if (typeof b.text !== "string" || !b.text.trim()) return fail("자료 내용을 붙여 넣으세요.");
  if (b.text.length > 500_000) return fail("자료가 너무 깁니다. 필요한 부분만 붙여 넣으세요.");
  return ok(await addRef(id, String(b.name ?? ""), b.text));
});

export const DELETE = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/references">) => {
  const { id } = await ctx.params;
  const refId = new URL(req.url).searchParams.get("refId") ?? "";
  if (!refId) return fail("지울 자료를 고르세요.");
  await deleteRef(id, refId);
  return ok({ ok: true });
});
