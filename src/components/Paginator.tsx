"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PagedInfo, SectionPageInfo } from "./types";

/** 입력이 이만큼 멈춘 뒤에만 잰다 — 같은 출처 iframe의 조판은 편집 화면과 같은 스레드에서 돌아 타자를 막는다 */
const QUIET_MS = 3000;
/** 측정이 이 안에 끝나지 않으면(조판이 멈춤) 버리고 다음 측정을 막지 않는다 */
const FULL_TIMEOUT_MS = 90_000;
const SECTION_TIMEOUT_MS = 30_000;

let lastInputAt = 0;
if (typeof window !== "undefined") {
  const mark = () => (lastInputAt = Date.now());
  window.addEventListener("keydown", mark, true);
  window.addEventListener("compositionupdate", mark, true);
}

/** 입력이 멈추고 브라우저가 한가할 때 fn — 돌려준 함수로 취소 */
function whenQuiet(fn: () => void) {
  let t: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  const ric = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  const check = () => {
    const wait = lastInputAt + QUIET_MS - Date.now();
    if (wait > 0) {
      t = setTimeout(check, wait);
      return;
    }
    if (ric) idle = ric(fn, { timeout: 4000 });
    else t = setTimeout(fn, 200);
  };
  check();
  return () => {
    clearTimeout(t);
    if (idle !== undefined) (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(idle);
  };
}

/**
 * 보이지 않는 iframe에서 실제 조판(Paged.js)으로 쪽 번호·절별 쪽 범위를 잰다.
 * - trigger: 책 전체를 다시 잰다 (절 이동·목차·조판 설정이 바뀐 뒤). 입력이 잠잠해진 뒤(8초 + 입력이 멈추고 한가할 때)
 *   재는 중에 다시 요청되면 지금 측정을 끊지 않고 끝난 뒤 한 번만 더 잰다.
 * - section: 그 절 하나만 잰다 (쓰는 중 분량이 바뀔 때). 절은 항상 새 쪽에서 시작하므로 그 절 쪽수만 새로 알면 된다
 * 책 전체 쪽수가 바뀌면 표지 책등 계산용으로 서버에 알린다 (실패해도 넘어간다).
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
  const pendingFull = useRef(false);
  const cancelQuiet = useRef<(() => void) | null>(null);
  const postedTotal = useRef<number | null>(null);

  const startFull = useCallback(() => {
    if (jobRef.current && !jobRef.current.sid) {
      pendingFull.current = true; // 재는 중 — 끝난 뒤 한 번 더
      return;
    }
    pendingFull.current = false;
    cancelQuiet.current?.();
    cancelQuiet.current = whenQuiet(() => {
      cancelQuiet.current = null;
      setJob({ src: `/book/${projectId}?mode=measure&t=${Date.now()}` });
    });
  }, [projectId]);

  useEffect(() => {
    const delay = first.current ? 300 : 8000;
    first.current = false;
    const t = setTimeout(startFull, delay);
    return () => clearTimeout(t);
  }, [projectId, trigger, startFull]);

  useEffect(() => () => cancelQuiet.current?.(), []);

  useEffect(() => {
    if (!section) return;
    let cancel: (() => void) | null = null;
    const t = setTimeout(() => {
      cancel = whenQuiet(() => {
        // 책 전체를 재는 중이면(또는 곧 잴 예정이면) 그 결과에 이 절도 들어간다
        if ((jobRef.current && !jobRef.current.sid) || pendingFull.current || cancelQuiet.current) return;
        setJob({ src: `/book/${projectId}?mode=measure&scope=section&sid=${encodeURIComponent(section.sid)}&t=${Date.now()}`, sid: section.sid });
      });
    }, 1500);
    return () => {
      clearTimeout(t);
      cancel?.();
    };
  }, [projectId, section]);

  // 멈춘 측정은 버린다 — 다음 측정이 영영 막히지 않게
  useEffect(() => {
    if (!job) {
      if (pendingFull.current) startFull();
      return;
    }
    const t = setTimeout(() => setJob((j) => (j === job ? null : j)), job.sid ? SECTION_TIMEOUT_MS : FULL_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [job, startFull]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== location.origin || e.data?.type !== "paged" || e.data.mode !== "measure") return;
      const j = jobRef.current;
      const info = e.data.info as PagedInfo;
      if (j?.sid) {
        const s = info.sections[j.sid];
        if (s) cb.current.onSection(j.sid, s);
      } else {
        cb.current.onInfo(info);
        // 책등 폭 계산용 전체 쪽수 — 바뀐 때만, 기다리지 않고 (없는 기능·실패는 무시)
        if (Number.isFinite(info.total) && info.total > 0 && info.total !== postedTotal.current) {
          postedTotal.current = info.total;
          fetch(`/api/projects/${projectId}/page-count`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ total: info.total }) }).catch(() => {});
        }
      }
      setJob(null); // 측정 끝나면 iframe 해제
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [projectId]);

  if (!job) return null;
  return <iframe key={job.src} ref={frame} src={job.src} title="measure" aria-hidden className="pointer-events-none fixed -left-[9999px] top-0 h-[900px] w-[1300px] opacity-0" />;
}
