"use client";

import { useEffect, useRef, useState } from "react";
import type { PagedInfo } from "./types";

/**
 * 보이지 않는 iframe에서 책 전체를 실제 조판(Paged.js)해 쪽 번호·절별 쪽 범위를 잰다.
 * 저장이 일어나면 입력이 잠잠해진 뒤(8초) 다시 잰다.
 */
export default function Paginator({ projectId, trigger, onInfo }: { projectId: string; trigger: number; onInfo: (i: PagedInfo) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const onInfoRef = useRef(onInfo);
  onInfoRef.current = onInfo;
  const first = useRef(true);
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const delay = first.current ? 300 : 8000;
    first.current = false;
    const t = setTimeout(() => setSrc(`/book/${projectId}?mode=measure&t=${Date.now()}`), delay);
    return () => clearTimeout(t);
  }, [projectId, trigger]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== location.origin || e.data?.type !== "paged" || e.data.mode !== "measure") return;
      onInfoRef.current(e.data.info);
      setSrc(null); // 측정 끝나면 iframe 해제
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  if (!src) return null;
  return <iframe ref={frame} src={src} title="measure" aria-hidden className="pointer-events-none fixed -left-[9999px] top-0 h-[900px] w-[1300px] opacity-0" />;
}
