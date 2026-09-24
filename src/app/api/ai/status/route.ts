import { handle, ok } from "@/lib/api";
import { chat } from "@/lib/ai/client";
import { publicAiSettings } from "@/lib/ai/settings";

export const GET = handle(async () => ok(await publicAiSettings()));

/** 연결 확인 — 아주 짧은 호출 */
export const POST = handle(async () => {
  const started = Date.now();
  try {
    const r = await chat({ purpose: "ping", messages: [{ role: "user", content: "'연결됨' 한 단어만 답하라." }], maxTokens: 20, temperature: 0 });
    return ok({ ok: true, ms: Date.now() - started, reply: r.text.trim() });
  } catch (e: any) {
    return ok({ ok: false, ms: Date.now() - started, error: e?.message });
  }
});
