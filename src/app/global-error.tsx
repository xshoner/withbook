"use client";

import { useEffect } from "react";

/** 최상위 레이아웃까지 멈췄을 때 — globals.css가 없을 수 있어 스타일을 직접 넣는다 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const btn = { padding: "8px 14px", borderRadius: 6, border: "1px solid #a8a29e", background: "#fff", color: "#292524", fontSize: 14, cursor: "pointer", textDecoration: "none" };
  return (
    <html lang="ko">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f5f5f4", color: "#292524" }}>
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ maxWidth: 420, background: "#fff", border: "1px solid #e7e5e4", borderRadius: 12, padding: 24, textAlign: "center" }}>
            <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>앱을 표시하지 못했습니다</h1>
            <p style={{ fontSize: 14, lineHeight: 1.6, color: "#57534e", margin: "0 0 16px" }}>
              일시적인 오류일 수 있습니다. 입력하던 원고는 브라우저에 보관돼 있으니 다시 시도해 보세요.
              {error.digest && <span style={{ display: "block", fontSize: 12, color: "#a8a29e" }}>오류 번호: {error.digest}</span>}
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button type="button" style={{ ...btn, background: "#292524", color: "#fff", borderColor: "#292524" }} onClick={() => reset()}>
                다시 시도
              </button>
              {/* 레이아웃이 깨졌을 수 있어 next/link 대신 전체 새로 고침으로 옮긴다 */}
              <a href="/projects" style={btn}>
                프로젝트 목록
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
