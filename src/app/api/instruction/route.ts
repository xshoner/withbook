import { fail, handle, ok } from "@/lib/api";
import { getSetting, setSetting } from "@/lib/app-settings";
import { loadInstruction } from "@/lib/ai/prompts";

type Hist = { at: string; text: string }[];

/** instruction.md(서술 기본 규칙) — 앱에 저장한 값은 DB에, 이전 내용은 최근 20개까지 보관 */
export const GET = handle(async () => {
  const text = await loadInstruction();
  const history = ((await getSetting<Hist>("instructionHistory")) ?? []).map((h) => h.at);
  const saved = await getSetting<string>("instruction");
  return ok({ path: saved ? "앱 설정(DB)에 저장된 규칙" : "instruction.md 파일", text, history });
});

export const PUT = handle(async (req: Request) => {
  const { text } = await req.json();
  if (typeof text !== "string" || !text.trim()) return fail("내용이 비어 있습니다.");
  if (text.length > 200_000) return fail("내용이 너무 깁니다.");
  const cur = await loadInstruction();
  if (cur && cur !== text) {
    const hist = (await getSetting<Hist>("instructionHistory")) ?? [];
    await setSetting("instructionHistory", [{ at: new Date().toISOString(), text: cur }, ...hist].slice(0, 20));
  }
  await setSetting("instruction", text);
  return ok({ ok: true });
});
