import { prisma } from "@/lib/db";
import { fail, handle, ok } from "@/lib/api";
import { getSetting, setSetting } from "@/lib/app-settings";
import { generateOutline, loadEditedOutline } from "@/lib/ai/tasks";
import { editedOutlineKey, outlineCacheKey, outlineInputHash, partsToText, textToParts, type EditedOutline, type OutlinePart } from "@/lib/ai/outline-text";
import { listRefs } from "@/lib/section-refs-store";

export const maxDuration = 300;

/**
 * 긴 절 집필 개요 — 작가가 집필 전에 보고 고칠 수 있다.
 *   GET  (?targetPages=)          → { outline: string | null, edited: boolean, stale: boolean }
 *   POST { sketch?, targetPages? } → 지금 새로 만든다(캐시 무시) → { outline, edited: false, stale: false }
 *   PUT  { outline, targetPages? } → 작가가 고친 개요 저장(edited) → 이후 /write가 이 개요를 그대로 쓴다
 *   DELETE                          → 고친 개요와 개요 캐시를 지운다(다음 집필 때 새로 만든다)
 * stale: 개요를 만든(고친) 뒤 스케치·목표 쪽수·절 제목·요지·참고 자료가 바뀌었다.
 */

async function sectionInfo(id: string) {
  const s = await prisma.section.findUnique({ where: { id }, select: { id: true, sketch: true, targetPages: true, title: true, gist: true } });
  if (!s) throw Object.assign(new Error("절을 찾을 수 없습니다."), { status: 404 });
  return s;
}

const pagesOf = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 60 ? n : fallback;
};

async function currentHash(s: Awaited<ReturnType<typeof sectionInfo>>, targetPages: number, sketch?: string) {
  const refIds = (await listRefs(s.id)).map((r) => r.id);
  return outlineInputHash({ sketch: sketch ?? s.sketch, targetPages, title: s.title, gist: s.gist, refIds });
}

export const GET = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/outline">) => {
  const { id } = await ctx.params;
  const s = await sectionInfo(id);
  const hash = await currentHash(s, pagesOf(new URL(req.url).searchParams.get("targetPages"), s.targetPages));
  const edited = await loadEditedOutline(id);
  if (edited) return ok({ outline: edited.outline, edited: true, stale: edited.inputHash !== hash });
  const cache = await getSetting<{ parts?: OutlinePart[]; expires?: number; inputHash?: string }>(outlineCacheKey(id), { fresh: true });
  if (cache?.parts?.length && (cache.expires ?? 0) > Date.now()) {
    return ok({ outline: partsToText(cache.parts), edited: false, stale: cache.inputHash !== hash });
  }
  return ok({ outline: null, edited: false, stale: false });
});

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/outline">) => {
  const { id } = await ctx.params;
  const s = await sectionInfo(id);
  const b = await req.json().catch(() => ({}));
  if (b.sketch !== undefined && typeof b.sketch !== "string") return fail("스케치 형식이 올바르지 않습니다.");
  if (typeof b.sketch === "string" && b.sketch.length > 20000) return fail("스케치가 너무 깁니다.");
  const targetPages = pagesOf(b.targetPages, s.targetPages);
  const { parts } = await generateOutline(id, { sketch: b.sketch, targetPages, signal: req.signal });
  // 형식이 틀린 응답이면 집필은 소제목 없는 한 덩어리로 쓰지만, 작가에게 보여 줄 개요로는 쓸모가 없다
  if (parts.length === 1 && !parts[0].heading && !parts[0].points.length) return fail("개요 응답을 해석하지 못했습니다. 다시 시도하세요.", 502);
  // 새로 만든 개요가 다음 집필에 쓰이도록 작가가 고쳤던 개요는 지운다
  await prisma.appSetting.deleteMany({ where: { key: editedOutlineKey(id) } });
  return ok({ outline: partsToText(parts), edited: false, stale: false });
});

export const PUT = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/outline">) => {
  const { id } = await ctx.params;
  const s = await sectionInfo(id);
  const b = await req.json();
  if (typeof b.outline !== "string") return fail("개요를 입력하세요.");
  const targetPages = pagesOf(b.targetPages, s.targetPages);
  const project = await prisma.section.findUnique({ where: { id }, select: { chapter: { select: { project: { select: { charsPerPage: true } } } } } });
  const cpp = project?.chapter.project.charsPerPage || 700;
  const parts = textToParts(b.outline, Math.round(targetPages * cpp));
  const value: EditedOutline = { outline: partsToText(parts), parts, inputHash: await currentHash(s, targetPages), editedAt: new Date().toISOString() };
  await setSetting(editedOutlineKey(id), value);
  return ok({ outline: value.outline, edited: true, stale: false });
});

export const DELETE = handle(async (_req: Request, ctx: RouteContext<"/api/sections/[id]/outline">) => {
  const { id } = await ctx.params;
  await prisma.appSetting.deleteMany({ where: { key: { in: [editedOutlineKey(id), outlineCacheKey(id)] } } });
  return ok({ ok: true });
});
