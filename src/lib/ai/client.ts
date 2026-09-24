import "server-only";
import { prisma } from "../db";
import { endpointOf, loadAiSettings, resolvedKey } from "./settings";

/**
 * OpenAI 호환 Chat Completions 클라이언트 (서버 전용)
 * 주소·모델·키는 AI 설정(data/ai-settings.json)에서, 없으면 .env에서 읽는다. 키는 서버에만 있다.
 */
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatOptions = {
  purpose: string;
  projectId?: string | null;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  instructionIncluded?: boolean;
};

export type Usage = { promptTokens: number; completionTokens: number; cost: number; truncated?: boolean };

const TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;

async function config() {
  const s = await loadAiSettings();
  const key = resolvedKey(s);
  if (!s.baseUrl || !key) throw new AiError(`AI 연결 설정이 없습니다. [책 설정 → AI 설정]에서 주소와 키(${s.keyName})를 확인하세요.`, 0);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (s.authScheme === "bearer") headers.Authorization = `Bearer ${key}`;
  else headers["x-api-key"] = key;
  return { url: endpointOf(s.baseUrl), headers, model: s.model, provider: s.provider, maxOut: s.maxOutputTokens };
}

export class AiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryable = (s: number) => s === 429 || s >= 500 || s === 0;

function parseUsage(u: any, est?: any): Usage {
  const cost = Number(est?.amount ?? u?.cost ?? 0) || 0;
  return {
    promptTokens: Number(u?.prompt_tokens ?? 0) || 0,
    completionTokens: Number(u?.completion_tokens ?? 0) || 0,
    cost,
  };
}

async function log(opts: ChatOptions, started: number, status: string, usage?: Usage, error?: string) {
  try {
    await prisma.aiLog.create({
      data: {
        projectId: opts.projectId ?? null,
        purpose: opts.purpose,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        cost: usage?.cost ?? 0,
        ms: Date.now() - started,
        status,
        error: error?.slice(0, 500),
        instructionIncluded: Boolean(opts.instructionIncluded),
      },
    });
  } catch {}
}

async function post(body: object, signal?: AbortSignal): Promise<Response> {
  const { url, headers } = await config();
  let lastErr: AiError | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new AiError("사용자가 중지했습니다.", 499);
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    // 응답 헤더를 받을 때까지만 120초 제한 (본문 스트림은 호출자가 무응답 시간으로 관리)
    const connect = new AbortController();
    const t = setTimeout(() => connect.abort(), TIMEOUT_MS);
    const sig = signal ? AbortSignal.any([signal, connect.signal]) : connect.signal;
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: sig });
      clearTimeout(t);
      if (res.ok) return res;
      const text = await res.text().catch(() => "");
      lastErr = new AiError(`AI 서버 오류 (${res.status}): ${text.slice(0, 300)}`, res.status);
      if (!retryable(res.status)) throw lastErr;
    } catch (e: any) {
      if (e instanceof AiError && !retryable(e.status)) throw e;
      if (signal?.aborted) throw new AiError("사용자가 중지했습니다.", 499);
      lastErr = e instanceof AiError ? e : new AiError(`AI 서버에 연결할 수 없습니다: ${e?.message ?? e}`, 0);
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr ?? new AiError("AI 호출 실패", 0);
}

/**
 * 한 번에 결과를 받는 호출.
 * 긴 생성(목차·교정 등)이 전체 120초 제한에 걸리지 않도록 내부적으로 스트리밍으로 받고,
 * "응답 없음 120초"만 타임아웃으로 본다.
 */
export async function chat(opts: ChatOptions): Promise<{ text: string; usage: Usage }> {
  const gen = chatStream(opts);
  let text = "";
  while (true) {
    const r = await gen.next();
    if (r.done) return { text, usage: r.value };
    text += r.value;
  }
}

/**
 * 스트리밍 호출 — 텍스트 조각을 차례로 내보낸다.
 * 응답 없는 상태가 120초 이어지면 타임아웃. 중지되면 지금까지 받은 부분은 호출자가 보존한다.
 */
export async function* chatStream(opts: ChatOptions): AsyncGenerator<string, Usage> {
  const started = Date.now();
  const { model, provider, maxOut } = await config();
  const maxTokens = Math.min(opts.maxTokens ?? 4000, maxOut);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (opts.signal?.aborted) ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const kick = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  };
  let usage: Usage = { promptTokens: 0, completionTokens: 0, cost: 0 };
  let truncated = false;
  let status = "ok";
  let err: string | undefined;
  try {
    kick();
    const res = await post(
      {
        model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.7,
        // OpenAI 최신 모델은 max_completion_tokens만 받는다
        ...(provider === "openai" ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
        stream: true,
        ...(provider === "gateway" || provider === "openai" ? { stream_options: { include_usage: true } } : {}),
      },
      ctrl.signal,
    );
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      kick();
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          const delta = j?.choices?.[0]?.delta?.content;
          const fin = j?.choices?.[0]?.finish_reason;
          if (fin === "length") truncated = true;
          if (j?.usage) usage = parseUsage(j.usage, j.estimated_cost);
          if (delta) yield delta as string;
        } catch {}
      }
    }
    if (truncated) {
      usage.truncated = true;
      err = "출력 한도(max_tokens)에 도달해 중간에 끊겼습니다.";
    }
    return usage;
  } catch (e: any) {
    status = opts.signal?.aborted ? "aborted" : "error";
    err = ctrl.signal.aborted && !opts.signal?.aborted ? "응답이 120초 동안 없어 중단했습니다." : e?.message;
    if (status === "aborted") return usage;
    throw new AiError(err ?? "AI 스트리밍 오류", e?.status ?? 0);
  } finally {
    clearTimeout(idle);
    opts.signal?.removeEventListener("abort", onAbort);
    ctrl.abort();
    await log(opts, started, truncated && status === "ok" ? "truncated" : status, usage, err);
  }
}

/** 응답에서 JSON 객체 하나를 뽑아낸다 */
export function extractJson(text: string): any {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const s = cleaned.indexOf("{");
  const e = cleaned.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("JSON을 찾을 수 없습니다.");
  return JSON.parse(cleaned.slice(s, e + 1));
}
