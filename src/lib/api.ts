import "server-only";
import { NextResponse } from "next/server";
import { checkAccess } from "./security";
import { ZodError } from "zod";

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** 라우트 핸들러 예외를 한국어 오류 응답으로 바꾼다 */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A) => {
    try {
      if (args[0] instanceof Request) {
        const denied = checkAccess(args[0]);
        if (denied) return denied;
      }
      return await fn(...args);
    } catch (e: any) {
      console.error(e);
      if (e instanceof SyntaxError || e instanceof ZodError) return fail("입력 데이터 형식이 올바르지 않습니다.");
      if (e?.code === "P2025") return fail("항목을 찾을 수 없습니다.", 404);
      const status = e?.status >= 400 && e.status < 600 ? e.status : 500;
      return fail(status < 500 ? e.message : "서버에서 요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.", status);
    }
  };
}

/** NDJSON 스트림 응답 */
export function ndjson(gen: AsyncGenerator<unknown>, onClose?: () => void) {
  const enc = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const next = await gen.next();
        if (cancelled) return;
        if (next.done) { onClose?.(); controller.close(); }
        else controller.enqueue(enc.encode(JSON.stringify(next.value) + "\n"));
      } catch (e: any) {
        if (cancelled) return;
        controller.enqueue(enc.encode(JSON.stringify({ t: "error", v: "AI 작업 중 오류가 발생했습니다. 연결 상태를 확인해주세요." }) + "\n"));
        console.error(e);
        onClose?.();
        controller.close();
      }
    },
    async cancel() {
      cancelled = true;
      onClose?.();
      await gen.return(undefined).catch(() => {});
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
