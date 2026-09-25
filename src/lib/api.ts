import "server-only";
import { NextResponse } from "next/server";
import { checkAccess, webMode } from "./security";
import { authenticate } from "./auth";
import { getRequestContext, runWithContext } from "./request-context";
import { ZodError } from "zod";

export { getRequestUser, requireRole } from "./request-context";

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * 라우트 핸들러 공통 처리: 출처 검사 → 로그인 사용자 확인 → 요청 문맥(사용자) 설정 → 예외를 한국어 오류 응답으로
 * 핸들러 안에서는 getRequestUser()/requireRole()로 사용자를 본다.
 */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A) => {
    const req = args[0] instanceof Request ? args[0] : null;
    if (!req) {
      if (webMode()) return fail("로그인이 필요합니다.", 401);
    } else {
      const denied = checkAccess(req);
      if (denied) return denied;
    }
    const auth = req ? await authenticate(req) : { user: { id: "local", email: "", role: "superadmin" as const } };
    if ("error" in auth) return auth.error;
    return runWithContext({ user: auth.user, startedAt: Date.now() }, async () => {
      try {
        return await fn(...args);
      } catch (e: any) {
        console.error(e);
        if (e instanceof SyntaxError || e instanceof ZodError) return fail("입력 데이터 형식이 올바르지 않습니다.");
        if (e?.code === "P2025") return fail("항목을 찾을 수 없습니다.", 404);
        // expose: 사용자에게 보여도 되는 오류 문구(AI 호출 오류·조판 시간 초과 등)
        if (e?.expose) return fail(e.message, e.httpStatus ?? 502);
        const status = e?.status >= 400 && e.status < 600 ? e.status : 500;
        return fail(status < 500 ? e.message : "서버에서 요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.", status);
      }
    });
  };
}

/** NDJSON 스트림 응답 — 스트림은 핸들러가 끝난 뒤에 읽히므로 요청 문맥(사용자)을 이어 붙인다 */
export function ndjson(gen: AsyncGenerator<unknown>, onClose?: () => void) {
  const enc = new TextEncoder();
  const ctx = getRequestContext();
  const inCtx = <T,>(fn: () => Promise<T>) => (ctx ? runWithContext(ctx, fn) : fn());
  let cancelled = false;
  const stream = new ReadableStream({
    pull: (controller) =>
      inCtx(async () => {
        try {
          const next = await gen.next();
          if (cancelled) return;
          if (next.done) { onClose?.(); controller.close(); }
          else controller.enqueue(enc.encode(JSON.stringify(next.value) + "\n"));
        } catch (e: any) {
          if (cancelled) return;
          const v = e?.expose ? e.message : "AI 작업 중 오류가 발생했습니다. 연결 상태를 확인해주세요.";
          controller.enqueue(enc.encode(JSON.stringify({ t: "error", v }) + "\n"));
          console.error(e);
          onClose?.();
          controller.close();
        }
      }),
    cancel: () =>
      inCtx(async () => {
        cancelled = true;
        onClose?.();
        await gen.return(undefined).catch(() => {});
      }),
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
