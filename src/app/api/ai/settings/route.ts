import { fail, handle, ok } from "@/lib/api";
import { publicAiSettings, saveAiSettings } from "@/lib/ai/settings";

/** AI 연결 설정 — 키는 가려서만 돌려준다 */
export const GET = handle(async () => ok(await publicAiSettings()));

export const PUT = handle(async (req: Request) => {
  const b = await req.json();
  if (b.keyName && !/^[A-Za-z][A-Za-z0-9_]*_KEY$/.test(String(b.keyName).trim()))
    return fail("호출 이름은 영문·숫자·밑줄로 쓰고 _KEY로 끝나야 합니다 (예: GEMINI_API_KEY).");
  await saveAiSettings({
    provider: b.provider,
    keyName: b.keyName,
    model: b.model,
    baseUrl: b.baseUrl,
    authScheme: b.authScheme,
    apiKey: typeof b.apiKey === "string" ? b.apiKey : "",
    maxOutputTokens: b.maxOutputTokens,
    clearKey: b.clearKey === true,
  });
  return ok(await publicAiSettings());
});
