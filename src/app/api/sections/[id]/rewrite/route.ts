import { fail, handle, ok } from "@/lib/api";
import { rewriteSelection } from "@/lib/ai/tasks";
import { snapshot } from "@/lib/sections";

export const maxDuration = 300;

const ACTIONS = new Set(["polish", "expand", "shorten", "tone", "example", "custom"]);
/** 작가가 직접 쓰는 지시(custom)의 최대 길이 */
const CUSTOM_INSTRUCTION_MAX = 500;

/**
 * 선택 영역 부분 수정. body: { action | mode, before, selection, after, content, toneTarget?, instruction? }
 * mode(또는 action) "custom"이면 instruction(작가 지시, 앞뒤 공백 제거 후 1~500자)대로 선택 부분만 고친다.
 */
export const POST = handle(async (req: Request, ctx: RouteContext<"/api/sections/[id]/rewrite">) => {
  const { id } = await ctx.params;
  const b = await req.json();
  const action = b.mode === "custom" ? "custom" : String(b.action ?? b.mode ?? "");
  if (!ACTIONS.has(action)) return fail("알 수 없는 작업입니다.");
  if (typeof b.selection !== "string" || !b.selection.trim()) return fail("고칠 부분을 선택하세요.");
  let instruction: string | undefined;
  if (action === "custom") {
    instruction = typeof b.instruction === "string" ? b.instruction.trim() : "";
    if (!instruction) return fail("어떻게 고칠지 지시를 입력하세요.");
    if (instruction.length > CUSTOM_INSTRUCTION_MAX) return fail(`지시는 ${CUSTOM_INSTRUCTION_MAX}자 이하로 입력하세요.`);
  }
  await snapshot(id, "rewrite", b.content);
  const text = await rewriteSelection(id, {
    action,
    before: String(b.before ?? ""),
    selection: b.selection,
    after: String(b.after ?? ""),
    toneTarget: typeof b.toneTarget === "string" ? b.toneTarget : undefined,
    instruction,
  });
  return ok({ text });
});
