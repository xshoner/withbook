import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { ROLES, USER_HEADER, userHeaderValue } from "./lib/auth";
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

  // 로그인이 필요 없는 경로는 세션을 확인하지 않는다 (첫 화면만 로그인 상태면 목록으로 보낸다)
  if (path !== "/" && PUBLIC.some((p) => p.test(path))) return NextResponse.next();

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
  const claims = data?.claims as { sub?: string; email?: string; app_metadata?: { role?: string } } | undefined;
  const role = claims?.app_metadata?.role ?? "";
  const allowed = Boolean(claims?.sub && ROLES.has(role));

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
  if (path.startsWith("/api/")) {
    // 확인한 사용자를 서명해 라우트로 넘긴다 → handle()이 세션을 다시 확인하지 않는다 (밖에서 보낸 같은 이름 헤더는 덮어쓴다)
    const headers = new Headers(request.headers);
    const v = userHeaderValue({ id: claims!.sub!, email: claims?.email ?? "", role: role as "superadmin" | "editor" });
    if (v) headers.set(USER_HEADER, v);
    const res = NextResponse.next({ request: { headers } });
    response.cookies.getAll().forEach((c) => res.cookies.set(c));
    return res;
  }
  return response;
}

// Paged.js(공개 라이브러리)는 로그인 확인 없이 캐시에서 바로 받는다
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|pagedjs).*)"] };
