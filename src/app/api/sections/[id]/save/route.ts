import { handle, ok } from "@/lib/api";
import { saveSection } from "@/lib/sections";

/** navigator.sendBeacon 용 (창 닫기 직전 저장) */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/save">) => {
  const { id } = await ctx.params;
  const text = await req.text();
  return ok(await saveSection(id, JSON.parse(text)));
});
