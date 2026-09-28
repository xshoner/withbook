import { z } from "zod";
import { fail, handle, ok } from "@/lib/api";
import { prisma } from "@/lib/db";
import { readBackMatter, writeBackMatter } from "@/lib/back-matter-store";
import { collectBiblio, suggestIndexTerms } from "@/lib/ai/back-matter-ai";

export const maxDuration = 300;

/**
 * 뒷붙이 — 찾아보기(색인)·참고문헌
 *   GET                                → { index, biblio }
 *   PUT { index?, biblio? }            → 저장한 값 (켜기·용어·항목)
 *   POST { action: "suggest-index" }   → { terms, dropped }  AI 추천(원고에 실제로 나오는 용어만) — 저장하지 않는다
 *   POST { action: "collect-biblio" }  → { entries, candidates, formatted }  원고에서 모아 정리 — 저장하지 않는다
 */
async function ensure(id: string) {
  if (!(await prisma.project.findFirst({ where: { id, deletedAt: null }, select: { id: true } }))) throw Object.assign(new Error("책을 찾을 수 없습니다."), { status: 404 });
}

export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/back-matter">) => {
  const { id } = await ctx.params;
  await ensure(id);
  return ok(await readBackMatter(id));
});

export const PUT = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/back-matter">) => {
  const { id } = await ctx.params;
  await ensure(id);
  const text = await req.text();
  if (text.length > 1_000_000) return fail("내용이 너무 큽니다.", 413);
  const b = JSON.parse(text);
  return ok(await writeBackMatter(id, { index: b.index, biblio: b.biblio }));
});

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/projects/[id]/back-matter">) => {
  const { id } = await ctx.params;
  await ensure(id);
  const { action } = z.object({ action: z.enum(["suggest-index", "collect-biblio"]) }).parse(await req.json());
  if (action === "suggest-index") return ok(await suggestIndexTerms(id, (await readBackMatter(id)).index.terms));
  return ok(await collectBiblio(id));
});
