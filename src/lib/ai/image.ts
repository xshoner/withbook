import "server-only";
import { prisma } from "../db";
import { getRequestContext, getRequestUser } from "../request-context";
import { AiError, upstreamMessage } from "./client";
import { baseUrlProblem, loadAiSettings, resolvedKey } from "./settings";

/** 표지 그림 기본 모델 (Letsur 게이트웨이 Images API) */
export const COVER_IMAGE_MODEL = "gpt-image-2.5-sunburst";

/** 기본 주소 → 경로. 버전 경로가 없으면(게이트웨이) /v1을 붙인다 — endpointOf와 같은 규칙 */
export function imageEndpointOf(baseUrl: string, path: "images/generations" | "images/edits" | "models" = "images/generations") {
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

async function log(projectId: string | null, purpose: string, started: number, status: string, cost = 0, error?: string) {
  try {
    await prisma.aiLog.create({
      data: { projectId, userId: getRequestUser()?.id ?? null, purpose, cost, ms: Date.now() - started, status, error: error?.slice(0, 500) },
    });
  } catch (e) {
    console.error("[ai] 사용 기록 저장 실패", e);
  }
}

type ImageCall = {
  prompt: string;
  size: string;
  fallbackSize: string;
  projectId: string;
  signal?: AbortSignal;
  /**
   * 있으면 수정(Images Edits, multipart). 요청 크기마다 입력을 만든다 — 크기를 바꿔 다시 부를 때
   * 비율이 달라도 그림이 늘어나지 않게(여백을 채워 맞춘 뒤 받은 그림에서 잘라 낸다).
   * mask: 바꿀 곳만 투명한 PNG (입력과 같은 크기)
   */
  edit?: { prepare: (size: string) => Promise<{ image: Buffer; mask?: Buffer }> };
};

/**
 * 그림 한 장 생성·수정 → PNG/JPEG 바이트.
 * 요청 크기를 모델이 거부하면(400) 크기를 바꿔 한 번 더 부른다.
 */
async function callImages(opts: ImageCall) {
  const { s, headers } = await coverConnection();
  const url = imageEndpointOf(s.baseUrl, opts.edit ? "images/edits" : "images/generations");
  const purpose = opts.edit ? "cover_image_edit" : "cover_image";
  const verb = opts.edit ? "그림 수정" : "그림 생성";
  const started = Date.now();
  const ctx = getRequestContext();
  const deadline = Math.min((ctx?.startedAt ?? started) + 250_000, started + IMAGE_TIMEOUT_MS);

  const body = async (size: string) => {
    if (!opts.edit) return { body: JSON.stringify({ model: s.model, prompt: opts.prompt, size, n: 1, quality: "high" }), headers };
    const fd = new FormData();
    fd.append("model", s.model);
    fd.append("prompt", opts.prompt);
    fd.append("size", size);
    fd.append("n", "1");
    fd.append("quality", "high");
    const input = await opts.edit.prepare(size);
    fd.append("image", new Blob([new Uint8Array(input.image)], { type: "image/png" }), "cover.png");
    if (input.mask) fd.append("mask", new Blob([new Uint8Array(input.mask)], { type: "image/png" }), "mask.png");
    // multipart 경계는 fetch가 붙이므로 Content-Type을 빼고 보낸다
    const { "Content-Type": _json, ...rest } = headers;
    return { body: fd, headers: rest };
  };

  const call = async (size: string) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.max(10_000, deadline - Date.now()));
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onAbort);
    try {
      const req = await body(size);
      const res = await fetch(url, { method: "POST", headers: req.headers, body: req.body, signal: ctrl.signal });
      const text = await res.text();
      let j: any = null;
      try {
        j = JSON.parse(text);
      } catch {}
      return { res, j };
    } catch (e: any) {
      if (opts.signal?.aborted) throw new AiError("사용자가 중지했습니다.", 499);
      if (ctrl.signal.aborted) throw new AiError(`${verb}이 제한 시간(약 4분) 안에 끝나지 않았습니다. 잠시 후 다시 시도하세요.`, 504);
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
    console.log(`[ai-call] ${JSON.stringify({ purpose, model: s.model, size, ms: Date.now() - started, bytes: buf.length })}`);
    await log(opts.projectId, purpose, started, "ok", cost);
    return { buffer: buf, size, model: s.model };
  } catch (e: any) {
    await log(opts.projectId, purpose, started, e?.status === 499 ? "aborted" : "error", 0, e?.message);
    throw e;
  }
}

export const generateImage = (opts: Omit<ImageCall, "edit">) => callImages(opts);

/** 지금 그림을 수정 프롬프트대로 고친다 (POST /v1/images/edits) */
export const editImage = (opts: ImageCall & { edit: NonNullable<ImageCall["edit"]> }) => callImages(opts);

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
