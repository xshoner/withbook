import { handle, ok } from "@/lib/api";
import { chat } from "@/lib/ai/client";
import { pingImageConnection } from "@/lib/ai/image";
import { publicAiSettings } from "@/lib/ai/settings";
import { parseAiScope } from "@/lib/ai/routing";

export const GET = handle(async () => ok(await publicAiSettings()));

/** 연결 확인 — 아주 짧은 호출 */
export const POST = handle(async (req: Request) => {
  const scope = parseAiScope(new URL(req.url).searchParams.get("scope"));
  const started = Date.now();
  try {
    // 표지 그림 연결은 그림을 만들지 않고(비용 없음) 모델 목록으로 키를 확인한다
    if (scope === "cover") return ok({ ok: true, ms: Date.now() - started, reply: (await pingImageConnection()).reply });
    const r = await chat({ purpose: "ping", connectionScope: scope, messages: [{ role: "user", content: "'연결됨' 한 단어만 답하라." }], maxTokens: 2048, temperature: 0 });
    if (!r.text.trim()) return ok({ ok: false, ms: Date.now() - started, error: "응답 본문이 비어 있습니다. 출력 토큰 한도와 모델 설정을 확인하세요." });
    return ok({ ok: true, ms: Date.now() - started, reply: r.text.trim() });
  } catch (e: any) {
    return ok({ ok: false, ms: Date.now() - started, error: e?.message });
  }
});
