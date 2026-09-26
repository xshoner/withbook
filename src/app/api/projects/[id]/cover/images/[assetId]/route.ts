import { handle, ok } from "@/lib/api";
import { deleteCoverImage } from "@/lib/cover/image-store";

/** [만든 그림] 삭제 — 표지 디자인·저장소·DB에서 지운다 */
export const DELETE = handle(async (_req: Request, ctx: RouteContext<"/api/projects/[id]/cover/images/[assetId]">) => {
  const { id, assetId } = await ctx.params;
  return ok(await deleteCoverImage(id, assetId));
});
