import { getRequestUser, handle, ok } from "@/lib/api";

/**
 * 지금 로그인한 사용자 — 화면이 관리자 전용 항목(고급 설정 등)을 보일지 정할 때 쓴다.
 * GET → { role: "superadmin" | "editor", email?: string } (로컬 모드는 superadmin)
 * 권한 검사는 각 API가 따로 한다(requireRole). 이 값은 화면 표시용이다.
 */
export const GET = handle(async () => {
  const u = getRequestUser();
  const role = u?.role === "superadmin" ? "superadmin" : "editor";
  return ok({ role, ...(u?.email ? { email: u.email } : {}) }, { headers: { "Cache-Control": "private, no-store" } });
});
