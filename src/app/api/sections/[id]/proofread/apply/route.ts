import { z } from "zod";
import { handle, ok } from "@/lib/api";
import { applyBlockChanges } from "@/lib/doc/edit";
import { editSections } from "@/lib/section-edit";

const body = z.object({
  changes: z.array(z.object({ i: z.number().int(), paragraph: z.number().int().positive(), before: z.string().min(1), after: z.string() })).max(2000),
});

/**
 * 교정 결과를 저장된 원고에 바로 적용 — 교정 중에 편집 화면을 떠났을 때(편집기 없이) 쓴다.
 * 교정 전 원고는 교정 요청 때 이미 버전(proofread)으로 남겼다. 적용된 항목 번호(i)를 돌려준다.
 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/proofread/apply">) => {
  const { id } = await ctx.params;
  const { changes } = body.parse(await req.json());
  let applied: number[] = [];
  await editSections(
    [id],
    "proofread",
    (doc) => {
      const r = applyBlockChanges(doc, changes);
      applied = r.applied.map((c) => c.i);
      return r.applied.length ? r.doc : null;
    },
    { status: "proofread", snapshot: false },
  );
  return ok({ applied });
});
