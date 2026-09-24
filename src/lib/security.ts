/**
 * 요청 출처 검사 — 모든 페이지·API에 적용된다.
 * - 로컬 모드(APP_ACCESS_MODE≠web): 이 컴퓨터(localhost)에서 온 요청만 허용
 * - 웹 모드: 로그인 확인은 proxy.ts(Supabase 세션)가 맡고, 여기서는 다른 사이트에서 보낸 변경 요청(CSRF)을 막는다
 */
export const webMode = () => process.env.APP_ACCESS_MODE === "web";

export function checkAccess(req: Request): Response | null {
  const url = new URL(req.url);
  const host = (req.headers.get("host") ?? url.host).toLowerCase();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
  if (!webMode() && !local) return Response.json({ error: "외부 접근이 비활성화되어 있습니다." }, { status: 403 });
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.get("origin");
    const trusted = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).origin : `${url.protocol}//${host}`;
    const proto = req.headers.get("x-forwarded-proto");
    const sameHost = origin ? new URL(origin).host === host && (!proto || new URL(origin).protocol === `${proto}:`) : true;
    if (req.headers.get("sec-fetch-site") === "cross-site" || (origin && origin !== trusted && !sameHost)) {
      return Response.json({ error: "다른 사이트에서 보낸 변경 요청은 허용하지 않습니다." }, { status: 403 });
    }
  }
  return null;
}
