import { createServerClient, parseCookieHeader } from "@supabase/ssr";
import { validRenderToken } from "./render-token";
import type { RequestUser, Role } from "./request-context";
import { webMode } from "./security";

/** 로그인 허용 역할 — Supabase 계정의 app_metadata.role (사용자가 스스로 바꿀 수 없는 값) */
export const ROLES = new Set<string>(["superadmin", "editor"]);

const LOCAL_USER: RequestUser = { id: "local", email: "", role: "superadmin" };
const RENDER_USER: RequestUser = { id: "render", email: "", role: "render" };

type Claims = { sub?: string; email?: string; app_metadata?: { role?: string } };

/**
 * 현재 사용자 확인 (API 라우트용). 세션 갱신 쿠키는 proxy.ts가 붙이므로 여기서는 읽기만 한다.
 * - 로컬 모드: 이 컴퓨터 사용자 = superadmin
 * - 웹 모드: PDF 조판 내부 토큰 → render, 아니면 Supabase 세션(getClaims)의 역할
 */
export async function authenticate(req: Request): Promise<{ user: RequestUser } | { error: Response }> {
  if (!webMode()) return { user: LOCAL_USER };
  if (validRenderToken(req)) return { user: RENDER_USER };
  let claims: Claims | undefined;
  try {
    const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
      cookies: {
        getAll: () => parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value ?? "" })),
        setAll: () => {},
      },
    });
    const { data } = await supabase.auth.getClaims();
    claims = data?.claims as Claims | undefined;
  } catch (e) {
    console.error("[auth] 세션 확인 실패", e);
  }
  const role = claims?.app_metadata?.role ?? "";
  if (!claims?.sub) return { error: Response.json({ error: "로그인이 필요합니다." }, { status: 401, headers: { "Cache-Control": "private, no-store" } }) };
  if (!ROLES.has(role)) return { error: Response.json({ error: "이 계정은 사용 권한이 없습니다." }, { status: 403, headers: { "Cache-Control": "private, no-store" } }) };
  return { user: { id: claims.sub, email: claims.email ?? "", role: role as Role } };
}
