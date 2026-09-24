import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * PDF를 만들 때 서버 안의 Chromium이 조판 페이지(/book, 글꼴, 이미지)를 열 수 있게 하는 짧은 내부 토큰.
 * 로그인 쿠키가 없는 서버 브라우저용이며 5분 뒤 만료되고, 읽기 요청(GET)과 조판 경로에만 쓸 수 있다.
 */
export const RENDER_HEADER = "x-withbook-render";
const PATHS = [/^\/book\/[a-zA-Z0-9_-]+$/, /^\/pagedjs$/, /^\/api\/assets\/[a-zA-Z0-9_-]+$/, /^\/api\/fonts\/[A-Za-z0-9._-]+$/];

const secret = () => process.env.RENDER_SECRET || process.env.SUPABASE_SECRET_KEY || "";

export function makeRenderToken(ttlMs = 5 * 60_000) {
  const exp = String(Date.now() + ttlMs);
  return `${exp}.${createHmac("sha256", secret()).update(exp).digest("hex")}`;
}

export function validRenderToken(req: Request) {
  const token = req.headers.get(RENDER_HEADER);
  if (!token || !secret() || req.method !== "GET") return false;
  const path = new URL(req.url).pathname;
  if (!PATHS.some((p) => p.test(path))) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = createHmac("sha256", secret()).update(exp).digest("hex");
  return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}
