import { handle, ok, requireRole } from "@/lib/api";
import { publicAiSettings, saveAiSettings } from "@/lib/ai/settings";

/** AI 연결 설정 — 키는 가려서만 돌려준다 */
export const GET = handle(async () => ok(await publicAiSettings()));

/** 저장은 관리자(superadmin)만. 호출 이름·주소 검사는 saveAiSettings가 한다 */
export const PUT = handle(async (req: Request) => {
  requireRole("superadmin");
  const b = await req.json();
  await saveAiSettings({
    provider: b.provider,
    keyName: typeof b.keyName === "string" ? b.keyName : undefined,
    model: b.model,
    baseUrl: b.baseUrl,
    authScheme: b.authScheme,
    apiKey: typeof b.apiKey === "string" ? b.apiKey : "",
    maxOutputTokens: b.maxOutputTokens,
    clearKey: b.clearKey === true,
  });
  return ok(await publicAiSettings());
});
