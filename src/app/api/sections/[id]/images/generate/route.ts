import { fail, handle, ok } from "@/lib/api";
import { deleteFigure, loadFigureHistory, makeFigure } from "@/lib/images/figure-store";
import { FIGURE_ASPECTS, FIGURE_STYLES } from "@/lib/images/figure-prompt";

export const maxDuration = 300;

/**
 * 이미지 추천 → [직접 만들기] (표지 디자인 AI와 같은 그림 연결)
 * GET → { history }  ·  POST { paragraph, style, aspect, instruction, withText, requestSize, customPrompt?, editOf?, editPrompt? } → { item, history }
 * customPrompt: 작가가 직접 고친 프롬프트 — 있으면 자동 프롬프트 대신 보낸다
 * DELETE ?assetId= → { history, kept }
 */
export const GET = handle(async (_req: Request, ctx: RouteContext<"/api/sections/[id]/images/generate">) => {
  const { id } = await ctx.params;
  return ok({ history: await loadFigureHistory(id) });
});

export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/images/generate">) => {
  const { id } = await ctx.params;
  const b = await req.json();
  const style = FIGURE_STYLES.some((s) => s.v === b.style) ? b.style : "diagram";
  const aspect = FIGURE_ASPECTS.some((a) => a.v === b.aspect) ? b.aspect : "landscape";
  const editOf = typeof b.editOf === "string" && /^[a-zA-Z0-9_-]+$/.test(b.editOf) ? b.editOf : undefined;
  return ok(
    await makeFigure(
      id,
      {
        paragraph: String(b.paragraph ?? "").slice(0, 3000),
        style,
        aspect,
        instruction: String(b.instruction ?? "").slice(0, 1000),
        withText: b.withText === true,
        requestSize: typeof b.requestSize === "string" ? b.requestSize.slice(0, 20) : "auto",
        editOf,
        editPrompt: typeof b.editPrompt === "string" ? b.editPrompt : undefined,
        customPrompt: typeof b.customPrompt === "string" ? b.customPrompt.slice(0, 12000) : undefined,
      },
      req.signal,
    ),
  );
});

export const DELETE = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/images/generate">) => {
  const { id } = await ctx.params;
  const assetId = new URL(req.url).searchParams.get("assetId") ?? "";
  if (!/^[a-zA-Z0-9_-]+$/.test(assetId)) return fail("이미지 ID가 올바르지 않습니다.");
  return ok(await deleteFigure(id, assetId));
});
