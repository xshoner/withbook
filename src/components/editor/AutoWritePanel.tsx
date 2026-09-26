"use client";

import { useEffect, useRef, useState } from "react";
import { summarize, type AutoItem, type Stage } from "@/lib/autowrite";
import { confirmDialog, toastError } from "../ui/feedback";
import { dismissAutoRun, loadAutoRun, onAutoEdited, pauseAutoRun, resumeAutoRun, stopAutoRun, useAutoWrite } from "./autoWrite";

/** 연속 실패로 멈춘 뒤 자동으로 다시 시도하기까지 · 한 화면에서 자동으로 다시 시도하는 최대 횟수 */
const ERROR_RETRY_S = 180;
const MAX_AUTO_RESUME = 3;
/** 소식이 끊긴 진행을 이어 받기까지 */
const STALE_RESUME_S = 10;

const STAGE: Record<Stage, [string, string]> = {
  pending: ["대기", "bg-stone-100 text-stone-400"],
  running: ["진행", "bg-violet-100 text-violet-700 animate-pulse"],
  done: ["완료", "bg-green-100 text-green-700"],
  skipped: ["—", "bg-stone-50 text-stone-300"],
  error: ["실패", "bg-red-100 text-red-700"],
};

/**
 * 전체 자동 집필 진행 창 — 편집 화면 오른쪽 아래에 떠 있다(절을 옮겨도 그대로).
 * 창을 다시 열었을 때 끊긴 진행이 있으면 잠시 뒤 자동으로 이어 가고, 연속 실패로 멈췄으면 3분 뒤 다시 시도한다.
 */
export default function AutoWritePanel({ projectId, onGoto, onEdited }: { projectId: string; onGoto: (sectionId: string) => void; onEdited: (sectionIds: string[]) => void }) {
  const s = useAutoWrite();
  const [open, setOpen] = useState(true);
  const [countdown, setCountdown] = useState<{ left: number; retryFailed: boolean; why: string } | null>(null);
  const autoResumes = useRef(0);
  const run = s.projectId === projectId ? s.run : null;

  useEffect(() => onAutoEdited(onEdited), [onEdited]);

  // 처음 열 때: 끊긴 진행 찾기 · 다른 창이 진행 중이면 15초마다 살펴 그 창이 닫히면 이어 받는다
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const r = await loadAutoRun(projectId);
        if (!alive) return;
        if (r === "stale") setCountdown({ left: STALE_RESUME_S, retryFailed: false, why: "지난 전체 자동 집필이 중간에 끊겼습니다" });
        if (r === "foreign") timer = setTimeout(check, 15_000);
      } catch {
        if (alive) timer = setTimeout(check, 30_000);
      }
    };
    void check();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [projectId]);

  // 연속 실패로 멈췄다 — 잠시 뒤 실패한 단계부터 자동으로 다시 (한 화면에서 최대 3번)
  useEffect(() => {
    if (run?.status === "paused" && run.pauseKind === "error" && !s.driving && autoResumes.current < MAX_AUTO_RESUME)
      setCountdown({ left: ERROR_RETRY_S, retryFailed: true, why: "연속 실패로 멈췄습니다" });
  }, [run?.status, run?.pauseKind, s.driving]);

  // 인터넷이 돌아오면 기다리지 않고 바로 다시
  useEffect(() => {
    const on = () => setCountdown((c) => (c ? { ...c, left: Math.min(c.left, 3) } : c));
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, []);

  useEffect(() => {
    if (!countdown) return;
    if (countdown.left <= 0) {
      const { retryFailed } = countdown;
      setCountdown(null);
      if (retryFailed) autoResumes.current++;
      resumeAutoRun(projectId, retryFailed).catch((e) => toastError(e, "자동 집필을 이어 가지 못했습니다: "));
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c ? { ...c, left: c.left - 1 } : c)), 1000);
    return () => clearTimeout(t);
  }, [countdown, projectId]);

  if (!run) return null;
  const sum = summarize(run);
  const failedItems = run.items.filter((x) => x.write === "error" || x.fact === "error" || x.review === "error");
  const statusText = s.foreign
    ? "다른 창에서 진행 중"
    : s.driving
      ? "진행 중"
      : run.status === "paused"
        ? "일시 정지"
        : run.status === "done"
          ? "완료"
          : run.status === "stopped"
            ? "끝냄"
            : "멈춤";
  const resume = (retryFailed: boolean) => {
    setCountdown(null);
    resumeAutoRun(projectId, retryFailed).catch((e) => toastError(e));
  };

  return (
    <div className="fixed bottom-4 right-4 z-40 w-[420px] max-w-[calc(100vw-2rem)] rounded-xl border border-violet-200 bg-white text-xs shadow-2xl">
      <div className="flex items-center gap-2 rounded-t-xl bg-violet-900 px-3 py-2 text-white">
        {s.driving && <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-violet-200 border-t-transparent" />}
        <button className="font-semibold hover:underline" onClick={() => setOpen((o) => !o)} title={open ? "접기" : "펼치기"}>
          ⚡ 전체 자동 집필 · {statusText}
        </button>
        <span className="text-violet-200">{sum.percent}%</span>
        <div className="ml-auto flex items-center gap-1">
          {s.driving && (
            <button className="rounded bg-white/15 px-2 py-0.5 hover:bg-white/25" onClick={pauseAutoRun} title="지금 하던 호출을 멈춥니다. 쓴 데까지는 저장되고 [이어서 진행]으로 계속합니다">
              일시 정지
            </button>
          )}
          {!s.driving && !s.foreign && (run.status === "paused" || run.status === "running") && (
            <button className="rounded bg-amber-500 px-2 py-0.5 font-semibold hover:bg-amber-400" onClick={() => resume(run.pauseKind === "error")}>
              이어서 진행
            </button>
          )}
          <button className="px-1 text-violet-200 hover:text-white" onClick={() => setOpen((o) => !o)} aria-label={open ? "접기" : "펼치기"}>
            {open ? "▾" : "▴"}
          </button>
        </div>
      </div>
      <div className="h-1.5 bg-violet-100">
        <div className="h-full bg-violet-500 transition-all" style={{ width: `${sum.percent}%` }} />
      </div>
      {countdown && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
          <span className="flex-1">
            {countdown.why}. <b>{countdown.left}초</b> 뒤 {countdown.retryFailed ? "실패한 단계부터" : "멈춘 곳부터"} 자동으로 이어 갑니다.
          </span>
          <button className="font-semibold hover:underline" onClick={() => resume(countdown.retryFailed)}>
            지금
          </button>
          <button className="text-amber-700 hover:underline" onClick={() => setCountdown(null)}>
            취소
          </button>
        </div>
      )}
      {open && (
        <>
          <div className="space-y-0.5 border-b border-stone-100 px-3 py-2 text-stone-600">
            <div>
              집필 {sum.written}/{sum.n - sum.writeSkipped}
              {run.options.factcheck && ` · 팩트체크 ${sum.checked}/${sum.n}`}
              {run.options.review && ` · 검수 ${sum.reviewed}/${sum.n}`}
              {sum.failed > 0 && <span className="text-red-600"> · 실패 {sum.failed}</span>}
            </div>
            {s.driving && (
              <>
                <div className="truncate text-amber-800" title={s.activity.writer}>
                  ✎ {s.activity.writer || "준비 중…"}
                </div>
                {(run.options.factcheck || run.options.review) && (
                  <div className="truncate text-violet-800" title={s.activity.checker}>
                    ✓ {s.activity.checker || "준비 중…"}
                  </div>
                )}
              </>
            )}
            {!s.driving && run.pauseReason && <div className="text-amber-800">{run.pauseReason}</div>}
            {s.foreign && <div className="text-stone-500">다른 창(탭)에서 진행하고 있습니다. 그 창이 닫히면 이 창이 이어 받습니다.</div>}
          </div>
          <ol className="max-h-[40vh] divide-y divide-stone-100 overflow-auto">
            {run.items.map((it, i) => (
              <Row key={it.sectionId} it={it} i={i} fact={run.options.factcheck} review={run.options.review} onGoto={onGoto} />
            ))}
          </ol>
          {!s.driving && !s.foreign && (
            <div className="flex flex-wrap items-center gap-2 border-t border-stone-100 px-3 py-2">
              {failedItems.length > 0 && (
                <button className="rounded bg-red-600 px-2 py-0.5 font-semibold text-white hover:bg-red-500" onClick={() => resume(true)}>
                  실패한 단계 다시 ({failedItems.length})
                </button>
              )}
              {(run.status === "paused" || run.status === "running") && (
                <button
                  className="text-stone-500 hover:underline"
                  onClick={async () => {
                    if (await confirmDialog("전체 자동 집필을 끝낼까요? 지금까지 쓴 원고는 그대로 남습니다.", { okLabel: "끝내기" })) {
                      setCountdown(null);
                      await stopAutoRun();
                    }
                  }}
                >
                  끝내기
                </button>
              )}
              {(run.status === "done" || run.status === "stopped") && (
                <button className="ml-auto text-stone-500 hover:underline" onClick={() => dismissAutoRun().catch((e) => toastError(e))}>
                  기록 닫기
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Row({ it, i, fact, review, onGoto }: { it: AutoItem; i: number; fact: boolean; review: boolean; onGoto: (id: string) => void }) {
  const chip = (label: string, st: Stage) => (
    <span className={`shrink-0 rounded px-1 text-[10px] ${STAGE[st][1]}`} title={`${label}: ${STAGE[st][0]}`}>
      {label} {STAGE[st][0]}
    </span>
  );
  const facts = it.factStats ? `판정 통과 ${it.factStats.pass} · 보완 ${it.factStats.revise}${it.factStats.fail ? ` · 실패 ${it.factStats.fail}` : ""}` : "";
  return (
    <li className="px-3 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="w-5 shrink-0 text-right text-stone-400">{i + 1}</span>
        <button className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => onGoto(it.sectionId)} title={`${it.chapterTitle} · 이 절로 가기`}>
          {it.label}
        </button>
        {chip("집필", it.write)}
        {fact && chip("팩트", it.fact)}
        {review && chip("검수", it.review)}
      </div>
      {(it.error || facts || it.reviewFixes !== undefined) && (
        <div className="ml-6 mt-0.5 space-y-0.5 text-[11px]">
          {(facts || it.reviewFixes !== undefined) && (
            <div className="text-stone-400">
              {facts}
              {facts && it.reviewFixes !== undefined && " · "}
              {it.reviewFixes !== undefined && `검수 ${it.reviewFixes}곳 고침`}
            </div>
          )}
          {it.error && <div className={it.error.startsWith("참고") ? "text-stone-500" : "text-red-600"}>{it.error}</div>}
        </div>
      )}
    </li>
  );
}
