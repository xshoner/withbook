"use client";

import { useEffect, useRef, useState } from "react";
import type { PagedInfo, SectionPageInfo } from "./types";

/**
 * 보이지 않는 iframe에서 실제 조판(Paged.js)으로 쪽 번호·절별 쪽 범위를 잰다.
 * - trigger: 책 전체를 다시 잰다 (절 이동·목차·조판 설정이 바뀐 뒤). 입력이 잠잠해진 뒤(8초)
 * - section: 그 절 하나만 잰다 (쓰는 중 분량이 바뀔 때). 절은 항상 새 쪽에서 시작하므로 그 절 쪽수만 새로 알면 된다
 */
export default function Paginator({
  projectId,
  trigger,
  section,
  onInfo,
  onSection,
}: {
  projectId: string;
  trigger: number;
  section: { sid: string; n: number } | null;
  onInfo: (i: PagedInfo) => void;
  onSection: (sid: string, s: SectionPageInfo) => void;
}) {
  const [job, setJob] = useState<{ src: string; sid?: string } | null>(null);
  const cb = useRef({ onInfo, onSection });
  cb.current = { onInfo, onSection };
  const first = useRef(true);
  const frame = useRef<HTMLIFrameElement>(null);
  const jobRef = useRef(job);
  jobRef.current = job;

  useEffect(() => {
    const delay = first.current ? 300 : 8000;
    first.current = false;
    const t = setTimeout(() => setJob({ src: `/book/${projectId}?mode=measure&t=${Date.now()}` }), delay);
    return () => clearTimeout(t);
  }, [projectId, trigger]);

  useEffect(() => {
    if (!section) return;
    const t = setTimeout(() => {
      // 책 전체를 재는 중이면 그 결과에 이 절도 들어간다
      if (jobRef.current && !jobRef.current.sid) return;
      setJob({ src: `/book/${projectId}?mode=measure&scope=section&sid=${encodeURIComponent(section.sid)}&t=${Date.now()}`, sid: section.sid });
    }, 1500);
    return () => clearTimeout(t);
  }, [projectId, section]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== location.origin || e.data?.type !== "paged" || e.data.mode !== "measure") return;
      const j = jobRef.current;
      const info = e.data.info as PagedInfo;
      if (j?.sid) {
        const s = info.sections[j.sid];
        if (s) cb.current.onSection(j.sid, s);
      } else cb.current.onInfo(info);
      setJob(null); // 측정 끝나면 iframe 해제
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  if (!job) return null;
  return <iframe key={job.src} ref={frame} src={job.src} title="measure" aria-hidden className="pointer-events-none fixed -left-[9999px] top-0 h-[900px] w-[1300px] opacity-0" />;
}
