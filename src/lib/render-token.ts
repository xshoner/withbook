import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * PDF를 만들 때 서버 안의 Chromium이 조판 페이지(/book, 글꼴, 이미지)를 열 수 있게 하는 짧은 내부 토큰.
 * 로그인 쿠키가 없는 서버 브라우저용이며 5분 뒤 만료되고, 읽기 요청(GET)과 조판 경로에만 쓸 수 있다.
 * 프로젝트 ID를 넣어 만들면 /book/{그 프로젝트}만 열린다(이미지·글꼴·pagedjs는 경로에 프로젝트가 없어 만료로만 제한).
 * 형식: {만료}.{프로젝트 또는 빈 값}.{서명}
 */
export const RENDER_HEADER = "x-withbook-render";
const PATHS = [/^\/book\/[a-zA-Z0-9_-]+$/, /^\/cover\/[a-zA-Z0-9_-]+$/, /^\/pagedjs$/, /^\/api\/assets\/[a-zA-Z0-9_-]+$/, /^\/api\/fonts\/[A-Za-z0-9._-]+$/];
const BOOK = /^\/(?:book|cover)\/([a-zA-Z0-9_-]+)$/;

let warned = false;
let localSecret = "";

/** 서명 키: RENDER_SECRET → (웹 모드는 경고 후) SUPABASE_SECRET_KEY → 로컬 모드는 프로세스마다 임의 값 */
function secret() {
  if (process.env.RENDER_SECRET) return process.env.RENDER_SECRET;
  const web = process.env.APP_ACCESS_MODE === "web";
  if (web && !warned) {
    warned = true;
    console.warn("[render-token] RENDER_SECRET이 없어 SUPABASE_SECRET_KEY로 서명합니다. 전용 RENDER_SECRET을 설정하세요.");
  }
  if (process.env.SUPABASE_SECRET_KEY) return process.env.SUPABASE_SECRET_KEY;
  if (web) return "";
  localSecret ||= randomBytes(32).toString("hex");
  return localSecret;
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("hex");

/** 서버 안에서만 오가는 값의 서명·확인 (proxy → API 사용자 전달 등). 용도 이름을 앞에 붙여 토큰끼리 섞이지 않게 한다 */
export function signInternal(purpose: string, payload: string) {
  return secret() ? createHmac("sha256", secret()).update(`${purpose}:${payload}`).digest("hex") : "";
}

export function verifyInternal(purpose: string, payload: string, sig: string) {
  const want = signInternal(purpose, payload);
  if (!want || want.length !== sig.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

export function makeRenderToken(ttlMs = 5 * 60_000, projectId = "") {
  const pid = /^[a-zA-Z0-9_-]*$/.test(projectId) ? projectId : "";
  const payload = `${Date.now() + ttlMs}.${pid}`;
  return `${payload}.${sign(payload)}`;
}

export function validRenderToken(req: Request) {
  const token = req.headers.get(RENDER_HEADER);
  if (!token || !secret() || req.method !== "GET") return false;
  const path = new URL(req.url).pathname;
  if (!PATHS.some((p) => p.test(path))) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [exp, pid, sig] = parts;
  if (!exp || !sig || !(Number(exp) >= Date.now())) return false;
  const want = sign(`${exp}.${pid}`);
  if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
  // 프로젝트에 묶인 토큰은 다른 프로젝트의 조판 페이지를 열지 못한다
  const book = BOOK.exec(path);
  return !(pid && book && book[1] !== pid);
}
