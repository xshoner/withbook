import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 요청 단위 문맥 — handle()이 로그인 사용자와 요청 시작 시각을 넣고, 깊은 코드(AI 호출 기록 등)가 꺼내 쓴다.
 * role "render"는 PDF 조판용 서버 브라우저(내부 토큰)로, 읽기 전용 조판 경로만 연다.
 */
export type Role = "superadmin" | "editor";
export type RequestUser = { id: string; email: string; role: Role | "render" };
export type RequestContext = { user: RequestUser; startedAt: number };

const als = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export const getRequestContext = () => als.getStore() ?? null;
export const getRequestUser = () => als.getStore()?.user ?? null;

const RANK: Record<string, number> = { editor: 1, superadmin: 2 };

/** 역할 확인 — 모자라면 403 오류를 던진다 (handle()이 한국어 응답으로 바꾼다) */
export function requireRole(role: Role): RequestUser {
  const user = getRequestUser();
  if (!user) throw Object.assign(new Error("로그인이 필요합니다."), { status: 401 });
  if ((RANK[user.role] ?? 0) < RANK[role]) {
    throw Object.assign(new Error(role === "superadmin" ? "관리자(superadmin)만 변경할 수 있습니다." : "이 계정은 사용 권한이 없습니다."), { status: 403 });
  }
  return user;
}
