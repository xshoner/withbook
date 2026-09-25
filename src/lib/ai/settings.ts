import "server-only";
import { getSetting, setSetting } from "../app-settings";
import { aiBaseUrlError, aiKeyNameError } from "../security";

/**
 * AI 연결 설정 — DB(AppSetting "ai")에 저장하고, 없으면 .env 값을 쓴다.
 * 키는 서버에만 있다. 화면에는 앞뒤 몇 글자만 가려서 보낸다.
 * 모든 제공자는 OpenAI 호환 Chat Completions 방식으로 부른다.
 */
export type AiProvider = "gateway" | "openai" | "gemini" | "anthropic" | "custom";
export type AuthScheme = "x-api-key" | "bearer";

export type AiSettings = {
  provider: AiProvider;
  keyName: string; // 호출 이름 — 키 칸이 비어 있으면 이 이름의 환경변수(.env)에서 키를 읽는다
  model: string;
  baseUrl: string;
  authScheme: AuthScheme;
  apiKey: string;
  maxOutputTokens: number; // 한 번 호출의 최대 출력 토큰 상한
};

export const PROVIDERS: Record<AiProvider, { label: string; baseUrl: string; keyName: string; model: string; authScheme: AuthScheme }> = {
  gateway: { label: "Letsur 게이트웨이", baseUrl: "https://gw.letsur.ai", keyName: "LLM_API_KEY", model: "claude-fable-5-1", authScheme: "x-api-key" },
  gemini: { label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyName: "GEMINI_API_KEY", model: "gemini-2.5-flash", authScheme: "bearer" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyName: "OPENAI_API_KEY", model: "gpt-5", authScheme: "bearer" },
  anthropic: { label: "Anthropic Claude", baseUrl: "https://api.anthropic.com/v1", keyName: "ANTHROPIC_API_KEY", model: "claude-sonnet-5", authScheme: "bearer" },
  custom: { label: "직접 입력 (OpenAI 호환)", baseUrl: "", keyName: "LLM_API_KEY", model: "", authScheme: "bearer" },
};

function fromEnv(): AiSettings {
  return {
    provider: "gateway",
    keyName: "LLM_API_KEY",
    model: process.env.LLM_MODEL ?? "claude-fable-5-1",
    baseUrl: (process.env.LLM_BASE_URL ?? "").replace(/\/+$/, ""),
    authScheme: (process.env.LLM_AUTH_SCHEME ?? "x-api-key").toLowerCase() === "bearer" ? "bearer" : "x-api-key",
    apiKey: "",
    maxOutputTokens: 32000,
  };
}

/** 저장된 설정(없으면 .env). apiKey가 비어 있으면 keyName 환경변수를 쓴다. */
export async function loadAiSettings(): Promise<AiSettings & { source: "file" | "env" }> {
  const raw = await getSetting<Partial<AiSettings>>("ai");
  if (raw) return { ...normalize({ ...fromEnv(), ...raw } as AiSettings), source: "file" };
  return { ...fromEnv(), source: "env" };
}

function normalize(s: AiSettings): AiSettings {
  const provider = (Object.keys(PROVIDERS) as AiProvider[]).includes(s.provider) ? s.provider : "custom";
  return {
    provider,
    keyName: String(s.keyName ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 64) || "LLM_API_KEY",
    model: String(s.model ?? "").trim().slice(0, 120),
    baseUrl: String(s.baseUrl ?? "").trim().replace(/\/+$/, "").slice(0, 300),
    authScheme: s.authScheme === "bearer" ? "bearer" : "x-api-key",
    apiKey: String(s.apiKey ?? "").trim().slice(0, 500),
    maxOutputTokens: Math.min(200000, Math.max(1000, Number(s.maxOutputTokens) || 32000)),
  };
}

export function resolvedKey(s: AiSettings) {
  // 키가 아닌 환경변수(DB 주소·Supabase 비밀 키 등)를 AI 서버로 보내지 않도록 허용된 …_API_KEY 이름만 읽는다
  return s.apiKey || (aiKeyNameError(s.keyName) ? "" : process.env[s.keyName]) || "";
}

/** 호출 직전 주소 검사 — 예전에 저장된 값도 막는다. 문제가 있으면 오류 문구 */
export const baseUrlProblem = (baseUrl: string) => aiBaseUrlError(baseUrl);

/** 기본 주소 → Chat Completions 주소. 버전 경로가 없으면(게이트웨이) /v1을 붙인다. */
export function endpointOf(baseUrl: string) {
  const b = baseUrl.replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(b)) return b;
  try {
    const u = new URL(b);
    return u.pathname && u.pathname !== "/" ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
  } catch {
    return `${b}/v1/chat/completions`;
  }
}

export function maskKey(k: string) {
  if (!k) return "";
  if (k.length <= 8) return "•".repeat(k.length);
  return `${k.slice(0, 4)}${"•".repeat(Math.min(16, k.length - 8))}${k.slice(-4)}`;
}

/** 화면에 보낼 설정 — 키는 가린다 */
export async function publicAiSettings() {
  const s = await loadAiSettings();
  const key = resolvedKey(s);
  return {
    provider: s.provider,
    keyName: s.keyName,
    model: s.model,
    baseUrl: s.baseUrl,
    endpoint: s.baseUrl ? endpointOf(s.baseUrl) : "",
    authScheme: s.authScheme,
    maxOutputTokens: s.maxOutputTokens,
    source: s.source,
    hasKey: Boolean(key),
    keyFrom: s.apiKey ? "saved" : key ? "env" : "none",
    keyMasked: maskKey(key),
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v])),
  };
}

/** 새 설정 저장. apiKey가 비어 있으면 기존 저장 키를 유지한다(keepKey). */
export async function saveAiSettings(input: Partial<AiSettings> & { clearKey?: boolean }) {
  const cur = await loadAiSettings();
  const next = normalize({
    ...cur,
    ...input,
    apiKey: input.clearKey ? "" : input.apiKey?.trim() ? input.apiKey : cur.apiKey,
  } as AiSettings);
  const bad = (m: string) => Object.assign(new Error(m), { status: 400 });
  if (!next.baseUrl) throw bad("기본 주소(Base URL)를 입력하세요.");
  const urlErr = aiBaseUrlError(next.baseUrl);
  if (urlErr) throw bad(urlErr);
  const keyErr = aiKeyNameError(next.keyName);
  if (keyErr) throw bad(keyErr);
  if (!next.model) throw Object.assign(new Error("호출 모델을 입력하세요."), { status: 400 });
  await setSetting("ai", next);
  return next;
}
