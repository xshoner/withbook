import "server-only";
import { prisma } from "../db";
import { getRequestContext } from "../request-context";
import { baseUrlProblem, endpointOf, loadAiSettings, resolvedKey } from "./settings";
import { scopeForPurpose, type AiScope } from "./routing";

export { extractJson } from "./extract-json";

/**
 * OpenAI 호환 Chat Completions 클라이언트 (서버 전용)
 * 주소·모델·키는 AI 설정(DB)에서, 없으면 .env에서 읽는다. 키는 서버에만 있다.
 * AI 서버의 응답 본문은 서버 로그에만 남기고 화면에는 상태 코드와 안내 문구만 보낸다.
 */
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ChatOptions = {
  purpose: string;
  /** Saved connection to test; normal calls route by purpose. */
  connectionScope?: AiScope;
  projectId?: string | null;
  messages: ChatMessage[];
  /** null이면 보내지 않는다(모델 기본값) — 추론 모델은 기본값 외의 temperature를 거부한다 */
  temperature?: number | null;
  maxTokens?: number;
  /** 최신 자료 검색 요청(OpenAI web_search_options) — 모델이 거부하면(400) 검색 없이 한 번 더 부른다 */
  webSearch?: boolean;
  signal?: AbortSignal;
  instructionIncluded?: boolean;
  /** 이 시각(epoch ms)까지 끝낸다 — 재시도·대기 포함. 기본: 요청 시작 + 240초 (Vercel 300초 제한 안) */
  deadline?: number;
};

export type Usage = {
  promptTokens: number;
  completionTokens: number;
  cost: number;
  /** 출력 중 추론(생각) 토큰 · 입력 중 캐시에서 읽은 토큰 — 게이트웨이가 알려 줄 때만 */
  reasoningTokens?: number;
  cachedTokens?: number;
  truncated?: boolean;
  deadline?: boolean;
};

const TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;
/** 요청 하나(여러 번의 AI 호출 포함)가 쓸 수 있는 시간 */
export const AI_BUDGET_MS = 240_000;
/** 남은 시간이 이보다 적으면 새 호출·재시도를 시작하지 않는다 */
const MIN_START_MS = 5_000;
/** Retry-After가 이보다 길면 기다리지 않고 실패로 본다 */
const MAX_RETRY_AFTER_MS = 60_000;
const DEADLINE_MSG = "서버 실행 시간 한도(약 4분)에 가까워 AI 호출을 중단했습니다. 잠시 후 다시 시도하거나 작업을 나눠 주세요.";

export class AiError extends Error {
  /** handle()·ndjson()이 이 문구를 그대로 사용자에게 보여 준다 */
  readonly expose = true;
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "AiError";
  }
  /** 우리 서버의 응답 코드 — AI 서버의 401 등을 그대로 돌려주면 로그인 문제로 오해하므로 502로 바꾼다 */
  get httpStatus() {
    return this.status === 499 || this.status === 504 ? this.status : 502;
  }
}

function deadlineOf(opts: ChatOptions) {
  if (opts.deadline) return opts.deadline;
  const ctx = getRequestContext();
  return (ctx?.startedAt ?? Date.now()) + AI_BUDGET_MS;
}

async function config(opts: ChatOptions) {
  const s = await loadAiSettings(opts.connectionScope ?? scopeForPurpose(opts.purpose));
  const key = resolvedKey(s);
  if (!s.baseUrl || !key) throw new AiError(`AI 연결 설정이 없습니다. [책 설정 → AI 설정]에서 주소와 키(${s.keyName})를 확인하세요.`, 0);
  const bad = baseUrlProblem(s.baseUrl);
  if (bad) throw new AiError(`AI 설정의 기본 주소를 쓸 수 없습니다: ${bad}`, 0);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (s.authScheme === "bearer") headers.Authorization = `Bearer ${key}`;
  else headers["x-api-key"] = key;
  return { url: endpointOf(s.baseUrl), headers, model: s.model, provider: s.provider, maxOut: s.maxOutputTokens, reasoningEffort: s.reasoningEffort };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
const retryable = (s: number) => s === 429 || s >= 500 || s === 0;

/** Retry-After 헤더(초 또는 HTTP 날짜) → 기다릴 ms */
export function retryAfterMs(h: string | null): number | null {
  if (!h) return null;
  const n = Number(h.trim());
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : Math.max(0, t - Date.now());
}

/** 상태 코드별 안내 문구 (AI 서버 응답 본문은 넣지 않는다) */
export function upstreamMessage(status: number) {
  if (status === 401 || status === 403) return `AI 서버 인증에 실패했습니다 (${status}). [AI 설정]의 키를 확인하세요.`;
  if (status === 404) return `AI 서버 주소나 모델을 찾을 수 없습니다 (${status}). [AI 설정]을 확인하세요.`;
  if (status === 413) return `AI 요청이 너무 깁니다 (${status}). 내용을 나눠서 시도하세요.`;
  if (status === 429) return `AI 서버 요청 한도를 넘었습니다 (${status}). 잠시 후 다시 시도하세요.`;
  if (status >= 500) return `AI 서버에 일시적인 문제가 있습니다 (${status}). 잠시 후 다시 시도하세요.`;
  if (status >= 400) return `AI 서버가 요청을 거부했습니다 (${status}). 모델 이름과 설정을 확인하세요.`;
  return `AI 서버 오류 (${status})`;
}

function parseUsage(u: any, est?: any): Usage {
  const cost = Number(est?.amount ?? u?.cost ?? 0) || 0;
  return {
    promptTokens: Number(u?.prompt_tokens ?? 0) || 0,
    completionTokens: Number(u?.completion_tokens ?? 0) || 0,
    cost,
    reasoningTokens: Number(u?.completion_tokens_details?.reasoning_tokens ?? u?.output_tokens_details?.reasoning_tokens ?? 0) || 0,
    cachedTokens: Number(u?.prompt_tokens_details?.cached_tokens ?? u?.cache_read_input_tokens ?? 0) || 0,
  };
}

async function log(opts: ChatOptions, userId: string | null, started: number, status: string, usage?: Usage, error?: string) {
  try {
    await prisma.aiLog.create({
      data: {
        projectId: opts.projectId ?? null,
        userId,
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
  } catch (e) {
    console.error("[ai] 사용 기록 저장 실패", e);
  }
}

async function post(url: string, headers: Record<string, string>, body: object, deadline: number, signal?: AbortSignal): Promise<Response> {
  let lastErr: AiError | null = null;
  let wait = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new AiError("사용자가 중지했습니다.", 499);
    if (attempt > 0) {
      // 기다린 뒤에도 호출할 시간이 남아야 재시도한다
      if (Date.now() + wait + MIN_START_MS > deadline) throw lastErr ?? new AiError(DEADLINE_MSG, 504);
      await sleep(wait, signal);
      if (signal?.aborted) throw new AiError("사용자가 중지했습니다.", 499);
    }
    const remaining = deadline - Date.now();
    if (remaining < MIN_START_MS) throw lastErr ?? new AiError(DEADLINE_MSG, 504);
    // 응답 헤더를 받을 때까지만 제한 (본문 스트림은 호출자가 무응답 시간으로 관리)
    const limit = Math.min(TIMEOUT_MS, remaining);
    const connect = new AbortController();
    const t = setTimeout(() => connect.abort(), limit);
    const sig = signal ? AbortSignal.any([signal, connect.signal]) : connect.signal;
    wait = 1000 * 2 ** attempt;
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: sig });
      if (res.ok) return res;
      const text = await res.text().catch(() => "");
      console.error(`[ai] ${new URL(url).host} 응답 ${res.status}:`, text.slice(0, 1000));
      lastErr = new AiError(upstreamMessage(res.status), res.status);
      if (!retryable(res.status)) throw lastErr;
      const ra = retryAfterMs(res.headers.get("retry-after"));
      if (ra !== null) {
        if (ra > MAX_RETRY_AFTER_MS) throw lastErr;
        wait = Math.max(ra, 500);
      }
    } catch (e: any) {
      if (e instanceof AiError) throw e;
      if (signal?.aborted) throw new AiError("사용자가 중지했습니다.", 499);
      if (connect.signal.aborted) {
        if (limit < TIMEOUT_MS) throw new AiError(DEADLINE_MSG, 504);
        lastErr = new AiError(`AI 서버가 ${TIMEOUT_MS / 1000}초 동안 응답하지 않았습니다.`, 0);
      } else {
        console.error("[ai] 연결 실패", e);
        lastErr = new AiError("AI 서버에 연결할 수 없습니다. 주소와 네트워크를 확인하세요.", 0);
      }
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr ?? new AiError("AI 호출에 실패했습니다.", 0);
}

/**
 * 한 번에 결과를 받는 호출.
 * 긴 생성(목차·교정 등)이 전체 120초 제한에 걸리지 않도록 내부적으로 스트리밍으로 받고,
 * "응답 없음 120초"만 타임아웃으로 본다. 실행 시간 한도(deadline)에 걸리면 오류(504).
 */
export async function chat(opts: ChatOptions): Promise<{ text: string; usage: Usage }> {
  const gen = chatStream(opts);
  let text = "";
  while (true) {
    const r = await gen.next();
    if (r.done) {
      if (r.value.deadline) throw new AiError(DEADLINE_MSG, 504);
      return { text, usage: r.value };
    }
    text += r.value;
  }
}

/**
 * 스트리밍 호출 — 텍스트 조각을 차례로 내보낸다.
 * 응답 없는 상태가 120초 이어지면 타임아웃. 중지되면 지금까지 받은 부분은 호출자가 보존한다.
 * 실행 시간 한도에 걸리면 받은 부분까지로 끝내고 usage.truncated·usage.deadline을 켠다(받은 것이 없으면 오류).
 * 호출자가 중간에 그만 읽어도(연결 끊김) finally에서 사용 기록을 남긴다.
 */
export async function* chatStream(opts: ChatOptions): AsyncGenerator<string, Usage> {
  const started = Date.now();
  const deadline = deadlineOf(opts);
  const user = getRequestContext()?.user;
  const userId = user && user.role !== "render" && user.id !== "local" ? user.id : null;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (opts.signal?.aborted) ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  let idleHit = false;
  let deadlineHit = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const kick = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      idleHit = true;
      ctrl.abort();
    }, TIMEOUT_MS);
  };
  const stopAt = setTimeout(() => {
    deadlineHit = true;
    ctrl.abort();
  }, Math.max(0, deadline - Date.now()));
  let usage: Usage = { promptTokens: 0, completionTokens: 0, cost: 0 };
  let truncated = false;
  let yielded = 0;
  let firstTextAt = 0;
  let modelName = "";
  let finished = false;
  let status = "ok";
  let err: string | undefined;
  try {
    const { url, headers, model, provider, maxOut, reasoningEffort } = await config(opts);
    modelName = model;
    const maxTokens = Math.min(opts.maxTokens ?? 4000, maxOut);
    const body = {
      model,
      messages: withCache(opts.messages, provider, model),
      ...(opts.temperature === null ? {} : { temperature: opts.temperature ?? 0.7 }),
      ...(effortFor(opts.purpose, provider, reasoningEffort) ? { reasoning_effort: effortFor(opts.purpose, provider, reasoningEffort) } : {}),
      // OpenAI 최신 모델은 max_completion_tokens만 받는다
      ...(provider === "openai" ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      stream: true,
      ...(provider === "gateway" || provider === "openai" ? { stream_options: { include_usage: true } } : {}),
    };
    const search = opts.webSearch && provider !== "anthropic" && provider !== "gemini";
    let res: Response;
    try {
      res = await post(url, headers, search ? { ...body, web_search_options: {} } : body, deadline, ctrl.signal);
    } catch (e) {
      // 검색을 지원하지 않는 모델 — 검색 없이(모델이 아는 가장 최근 자료로) 다시 부른다
      if (!search || !(e instanceof AiError) || e.status !== 400) throw e;
      console.warn(`[ai] ${model}: web_search_options 거부 — 검색 없이 다시 호출`);
      res = await post(url, headers, body, deadline, ctrl.signal);
    }
    // 연결(재시도 포함)은 post가 시간을 관리하고, 여기서부터 무응답 시간을 잰다
    kick();
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
        let j: any;
        try {
          j = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = j?.choices?.[0]?.delta?.content;
        if (delta && !firstTextAt) firstTextAt = Date.now();
        const fin = j?.choices?.[0]?.finish_reason;
        if (fin === "length") truncated = true;
        if (j?.usage) usage = parseUsage(j.usage, j.estimated_cost);
        if (delta) {
          yielded += String(delta).length;
          yield delta as string;
        }
      }
    }
    if (truncated) {
      usage.truncated = true;
      err = "출력 한도(max_tokens)에 도달해 중간에 끊겼습니다.";
    }
    finished = true;
    return usage;
  } catch (e: any) {
    finished = true;
    if (opts.signal?.aborted) {
      status = "aborted";
      err = "사용자가 중지했습니다.";
      return usage;
    }
    if (deadlineHit) {
      status = "deadline";
      err = DEADLINE_MSG;
      if (yielded > 0) return { ...usage, truncated: true, deadline: true };
      throw new AiError(DEADLINE_MSG, 504);
    }
    status = "error";
    if (idleHit) err = `응답이 ${TIMEOUT_MS / 1000}초 동안 없어 중단했습니다.`;
    else if (e instanceof AiError) err = e.message;
    else {
      console.error("[ai] 스트리밍 오류", e);
      err = "AI 응답을 받는 중 연결이 끊겼습니다.";
    }
    throw e instanceof AiError && !idleHit ? e : new AiError(err, 0);
  } finally {
    // 호출자가 중간에 그만 읽은 경우(연결 끊김·상위 작업 중단)에도 기록을 남긴다
    if (!finished) {
      status = "aborted";
      err = "연결이 끊겨 중단했습니다.";
    }
    clearTimeout(idle);
    clearTimeout(stopAt);
    opts.signal?.removeEventListener("abort", onAbort);
    ctrl.abort();
    // 호출별 시간·토큰 (첫 글자까지 걸린 시간, 추론·캐시 토큰) — 속도 측정용 구조화 로그, 프롬프트·원고는 넣지 않는다
    console.info(
      "[ai-call]",
      JSON.stringify({
        purpose: opts.purpose,
        model: modelName,
        status,
        ms: Date.now() - started,
        firstTextMs: firstTextAt ? firstTextAt - started : null,
        in: usage.promptTokens,
        out: usage.completionTokens,
        reasoning: usage.reasoningTokens ?? null,
        cached: usage.cachedTokens ?? null,
      }),
    );
    await log(opts, userId, started, truncated && status === "ok" ? "truncated" : status, usage, err);
  }
}

/**
 * 보낼 추론 강도 — 연결 설정의 값(기본이면 보내지 않음). 게이트웨이·Gemini·OpenAI가 reasoning_effort를 받는다.
 * 측정용: 환경변수 AI_REASONING_OVERRIDE="low" 또는 "section_write=low,section_outline=low"가 설정보다 앞선다(운영에는 두지 않는다).
 */
function effortFor(purpose: string, provider: string, configured?: string): string | null {
  const o = process.env.AI_REASONING_OVERRIDE?.trim();
  if (o) {
    if (!o.includes("=")) return o === "default" ? null : o;
    const hit = o.split(",").map((x) => x.trim().split("=")).find(([k]) => k === purpose || (k.endsWith("*") && purpose.startsWith(k.slice(0, -1))));
    if (hit) return hit[1] === "default" ? null : hit[1];
  }
  if (!configured || configured === "default") return null;
  return provider === "anthropic" ? null : configured;
}

/**
 * 프롬프트 캐시 — 게이트웨이의 Claude 모델은 system 메시지(instruction.md·책 정보·문체·목차, 절마다 같다)에 cache_control을 달면
 * 5분 안의 다음 호출(다른 절·긴 절의 다음 파트)이 그 부분을 캐시에서 읽는다. 결과는 같고, 첫 응답이 조금 빨라지며 입력 비용이 준다.
 * 내용이 짧으면(1,024토큰 미만) 캐시가 만들어지지 않으므로 긴 system에만 단다.
 */
export function withCache(messages: ChatMessage[], provider: string, model: string): unknown[] {
  if (provider !== "gateway" || !/claude/i.test(model)) return messages;
  return messages.map((m) =>
    m.role === "system" && m.content.length > 4000 ? { role: "system", content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] } : m,
  );
}
