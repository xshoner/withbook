import { handle, ok, requireRole } from "@/lib/api";
import { copyAiSettings, publicAiSettings, resetAiSettings, saveAiSettings } from "@/lib/ai/settings";
import { parseAiScope } from "@/lib/ai/routing";

/** AI 연결 설정 — 키는 가려서만 돌려준다 */
export const GET = handle(async (req: Request) => ok(await publicAiSettings(parseAiScope(new URL(req.url).searchParams.get("scope")))));

/** 저장은 관리자(superadmin)만. 호출 이름·주소 검사는 saveAiSettings가 한다 */
export const PUT = handle(async (req: Request) => {
  requireRole("superadmin");
  const b = await req.json();
  const scope = parseAiScope(b.scope);
  if (b.useDefault === true) {
    await resetAiSettings(scope);
    return ok(await publicAiSettings(scope));
  }
  if (b.copyFrom !== undefined) {
    await copyAiSettings(parseAiScope(b.copyFrom), scope);
    return ok(await publicAiSettings(scope));
  }
  await saveAiSettings({
    provider: b.provider,
    keyName: typeof b.keyName === "string" ? b.keyName : undefined,
    model: b.model,
    baseUrl: b.baseUrl,
    authScheme: b.authScheme,
    apiKey: typeof b.apiKey === "string" ? b.apiKey : "",
    maxOutputTokens: b.maxOutputTokens,
    reasoningEffort: b.reasoningEffort,
    clearKey: b.clearKey === true,
  }, scope);
  return ok(await publicAiSettings(scope));
});
