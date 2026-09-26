import "server-only";
import { prisma } from "../db";
import { getRequestContext, getRequestUser } from "../request-context";
import { AiError, upstreamMessage } from "./client";
import { baseUrlProblem, loadAiSettings, resolvedKey } from "./settings";

/** 표지 그림 기본 모델 (Letsur 게이트웨이 Images API) */
export const COVER_IMAGE_MODEL = "gpt-image-2.5-sunburst";

/** 기본 주소 → 경로. 버전 경로가 없으면(게이트웨이) /v1을 붙인다 — endpointOf와 같은 규칙 */
export function imageEndpointOf(baseUrl: string, path: "images/generations" | "models" = "images/generations") {
  const b = baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  try {
    const u = new URL(b);
    return u.pathname && u.pathname !== "/" ? `${b}/${path}` : `${b}/v1/${path}`;
  } catch {
    return `${b}/v1/${path}`;
  }
}

/** 표지 연결 — 기본 연결(글쓰기 모델)을 그대로 쓰면 그림 모델이 아니므로 개별 연결을 요구한다 */
async function coverConnection() {
  const s = await loadAiSettings("cover");
  if (s.inherited) throw new AiError("표지 그림 연결이 없습니다. [책 설정 → AI 설정 → 표지 디자인]에서 연결과 API 키를 등록하세요.", 0);
  const key = resolvedKey(s);
  if (!s.baseUrl || !key) throw new AiError(`표지 디자인 AI 키가 없습니다. [책 설정 → AI 설정 → 표지 디자인]에서 키(${s.keyName})를 입력하세요.`, 0);
  const bad = baseUrlProblem(s.baseUrl);
  if (bad) throw new AiError(`표지 디자인 연결의 기본 주소를 쓸 수 없습니다: ${bad}`, 0);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (s.authScheme === "bearer") headers.Authorization = `Bearer ${key}`;
  else headers["x-api-key"] = key;
  return { s, headers };
}

// 그림 생성은 1~3분 걸릴 수 있다 — 서버 한도(약 4분) 안에서 끝나게
const IMAGE_TIMEOUT_MS = 230_000;

async function log(projectId: string | null, started: number, status: string, cost = 0, error?: string) {
  try {
    await prisma.aiLog.create({
      data: { projectId, userId: getRequestUser()?.id ?? null, purpose: "cover_image", cost, ms: Date.now() - started, status, error: error?.slice(0, 500) },
    });
  } catch (e) {
    console.error("[ai] 사용 기록 저장 실패", e);
  }
}

/**
 * 그림 한 장 생성 → PNG/JPEG 바이트.
 * 요청 크기를 모델이 거부하면(400) 크기를 바꿔 한 번 더 부른다.
 */
export async function generateImage(opts: { prompt: string; size: string; fallbackSize: string; projectId: string; signal?: AbortSignal }) {
  const { s, headers } = await coverConnection();
  const url = imageEndpointOf(s.baseUrl);
  const started = Date.now();
  const ctx = getRequestContext();
  const deadline = Math.min((ctx?.startedAt ?? started) + 250_000, started + IMAGE_TIMEOUT_MS);

  const call = async (size: string) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.max(10_000, deadline - Date.now()));
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onAbort);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: s.model, prompt: opts.prompt, size, n: 1, quality: "high" }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let j: any = null;
      try {
        j = JSON.parse(text);
      } catch {}
      return { res, j };
    } catch (e: any) {
      if (opts.signal?.aborted) throw new AiError("사용자가 중지했습니다.", 499);
      if (ctrl.signal.aborted) throw new AiError("그림 생성이 제한 시간(약 4분) 안에 끝나지 않았습니다. 잠시 후 다시 시도하세요.", 504);
      throw new AiError(`AI 서버에 연결하지 못했습니다: ${e?.message ?? e}`, 0);
    } finally {
      clearTimeout(t);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  };

  try {
    let size = opts.size;
    let { res, j } = await call(size);
    if (res.status === 400 && opts.fallbackSize && opts.fallbackSize !== size && Date.now() < deadline - 60_000) {
      console.warn(`[cover-image] 크기 ${size} 거부(400) → ${opts.fallbackSize}로 다시 요청`);
      size = opts.fallbackSize;
      ({ res, j } = await call(size));
    }
    if (!res.ok) {
      const detail = typeof j?.error?.message === "string" ? ` — ${j.error.message.slice(0, 200)}` : "";
      throw new AiError(upstreamMessage(res.status) + (res.status === 400 ? detail : ""), res.status);
    }
    const item = j?.data?.[0];
    let buf: Buffer | null = null;
    if (typeof item?.b64_json === "string") buf = Buffer.from(item.b64_json, "base64");
    else if (typeof item?.url === "string" && /^https:\/\//.test(item.url)) {
      const r = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
      if (r.ok) buf = Buffer.from(await r.arrayBuffer());
    }
    if (!buf?.length) throw new AiError("AI 서버 응답에 그림이 없습니다. 모델 이름과 설정을 확인하세요.", 502);
    const cost = Number(j?.estimated_cost?.amount ?? 0) || 0;
    console.log(`[ai-call] ${JSON.stringify({ purpose: "cover_image", model: s.model, size, ms: Date.now() - started, bytes: buf.length })}`);
    await log(opts.projectId, started, "ok", cost);
    return { buffer: buf, size, model: s.model };
  } catch (e: any) {
    await log(opts.projectId, started, e?.status === 499 ? "aborted" : "error", 0, e?.message);
    throw e;
  }
}

/** 연결 점검 — 그림을 만들지 않고(비용 없음) 모델 목록으로 키·주소를 확인한다 */
export async function pingImageConnection() {
  const { s, headers } = await coverConnection();
  const res = await fetch(imageEndpointOf(s.baseUrl, "models"), { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new AiError(upstreamMessage(res.status), res.status);
  const j = await res.json().catch(() => null);
  const ids: string[] = Array.isArray(j?.data) ? j.data.map((m: any) => String(m?.id ?? "")) : [];
  const listed = ids.includes(s.model);
  return { reply: listed ? `키 확인됨 · ${s.model} 사용 가능` : ids.length ? `키 확인됨 · 모델 목록에 ${s.model}이 보이지 않습니다 (이름 확인)` : "키 확인됨", model: s.model, listed };
}
