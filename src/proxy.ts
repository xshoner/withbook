import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { ROLES } from "./lib/auth";
import { validRenderToken } from "./lib/render-token";
import { checkAccess, webMode } from "./lib/security";

/** 로그인 없이 열 수 있는 경로: 첫 화면(로그인), 글꼴, 상태 확인 */
const PUBLIC = [/^\/$/, /^\/api\/fonts\//, /^\/icon\.svg$/, /^\/api\/health$/];

export async function proxy(request: NextRequest) {
  const denied = checkAccess(request);
  if (denied) return denied;
  if (!webMode()) return NextResponse.next();

  const path = request.nextUrl.pathname;
  // 서버 안 PDF 조판 브라우저 (짧은 내부 토큰)
  if (validRenderToken(request)) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  // 세션을 확인하고(필요하면 갱신 쿠키를 붙인다) 역할을 본다
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims as { app_metadata?: { role?: string } } | undefined;
  const allowed = Boolean(claims && ROLES.has(claims.app_metadata?.role ?? ""));

  const withCookies = (res: NextResponse) => {
    response.cookies.getAll().forEach((c) => res.cookies.set(c));
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  };

  if (PUBLIC.some((p) => p.test(path))) {
    if (allowed && path === "/") return withCookies(NextResponse.redirect(new URL("/projects", request.url)));
    return response;
  }
  if (!allowed) {
    if (path.startsWith("/api/")) return withCookies(NextResponse.json({ error: claims ? "이 계정은 사용 권한이 없습니다." : "로그인이 필요합니다." }, { status: claims ? 403 : 401 }));
    const to = new URL("/", request.url);
    if (path !== "/projects") to.searchParams.set("next", path + request.nextUrl.search);
    return withCookies(NextResponse.redirect(to));
  }
  return response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
