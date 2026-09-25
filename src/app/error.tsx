"use client";

import Link from "next/link";
import { useEffect } from "react";

/** 화면 하나가 렌더링 중에 멈췄을 때 — 레이아웃(알림 등)은 그대로 두고 이 부분만 다시 그린다 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md rounded-xl border border-stone-200 bg-white p-6 text-center shadow-sm">
        <h1 className="mb-2 text-lg font-semibold text-stone-800">화면을 표시하지 못했습니다</h1>
        <p className="mb-4 text-sm leading-6 text-stone-600">
          일시적인 오류일 수 있습니다. 입력하던 원고는 브라우저에 보관돼 있으니 다시 시도해 보세요.
          {error.digest && <span className="mt-1 block text-xs text-stone-400">오류 번호: {error.digest}</span>}
        </p>
        <div className="flex justify-center gap-2">
          <button type="button" className="btn-primary" onClick={() => reset()}>
            다시 시도
          </button>
          <Link href="/projects" className="btn">
            프로젝트 목록
          </Link>
        </div>
      </div>
    </div>
  );
}
