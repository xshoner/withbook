"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";

type Change = { sectionId: string; sectionLabel: string; sectionTitle: string; paragraph: number; before: string; after: string; type: string; reason: string };

const TYPE: Record<string, string> = { duplicate: "중복", transition: "연결", flow: "흐름", consistency: "통일" };

/** 전체 장 퇴고에 쓰는 장 목록 (책 순서) */
export type ReviseChapter = { id: string; name: string };

type RunRow = { id: string; name: string; state: "wait" | "plan" | "apply" | "done" | "skip" | "fail"; note: string };

const STATE: Record<RunRow["state"], string> = { wait: "대기", plan: "장 전체 읽는 중…", apply: "적용 중…", done: "완료", skip: "건너뜀", fail: "실패" };

/** 본문이 거의 없는 장 — 서버(reviseChapter)가 거절하면 실패가 아니라 건너뛴 것으로 본다 */
const EMPTY_CHAPTER = "퇴고할 본문이 거의 없습니다";

/** 장 단위 퇴고 — 장 전체를 읽고 절 사이 중복·연결·흐름을 고치는 수정안을 받아, 고른 것만 적용한다 */
export default function ChapterReviseDialog({
  chapterId,
  chapterName,
  chapters,
  beforeRun,
  onApplied,
  onClose,
}: {
  chapterId: string;
  chapterName: string;
  chapters: ReviseChapter[];
  beforeRun: () => Promise<boolean>;
  onApplied: (sectionIds: string[]) => void;
  onClose: () => void;
}) {
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState<"" | "run" | "apply">("");
  const [plan, setPlan] = useState<{ overview: string; changes: Change[]; failed: Change[] } | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState("");
  // 전체 장 퇴고 — 장마다 퇴고안을 만들어 곧바로 모두 적용하고 다음 장으로 넘어간다
  const [rows, setRows] = useState<RunRow[] | null>(null);
  const [allRunning, setAllRunning] = useState(false);
  const stopRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const running = !!busy || allRunning;

  useEffect(() => {
    if (!allRunning) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [allRunning]);

  /** only가 있으면 그 장들만 다시 (실패·멈춘 장) */
  const runAll = async (only?: Set<string>) => {
    if (!only && !confirm(`모든 장(${chapters.length}개)을 차례로 퇴고하고 수정안을 모두 적용합니다. 장마다 1~3분 걸립니다.\n적용 전 원고는 절마다 버전 기록(장 퇴고 전)에 남습니다. 시작할까요?`)) return;
    setMsg("");
    setPlan(null);
    if (!(await beforeRun())) return setMsg("원고 저장을 완료한 뒤 다시 시도하세요.");
    const list: RunRow[] =
      only && rows ? rows.map((r) => (only.has(r.id) ? { ...r, state: "wait", note: "" } : r)) : chapters.map((c) => ({ id: c.id, name: c.name, state: "wait", note: "" }));
    setRows(list);
    const set = (id: string, patch: Partial<RunRow>) => setRows((rs) => rs?.map((r) => (r.id === id ? { ...r, ...patch } : r)) ?? rs);
    stopRef.current = false;
    setAllRunning(true);
    let total = 0;
    try {
      for (const row of list) {
        if (row.state !== "wait") continue;
        if (stopRef.current) break;
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        try {
          set(row.id, { state: "plan" });
          const r = await api<{ changes: Change[] }>(`/api/chapters/${row.id}/revise`, { method: "POST", json: { focus }, signal: ctrl.signal });
          if (!r.changes.length) {
            set(row.id, { state: "done", note: "고칠 곳 없음" });
            continue;
          }
          set(row.id, { state: "apply" });
          const changes = r.changes.map(({ sectionId, paragraph, before, after }) => ({ sectionId, paragraph, before, after }));
          const a = await api<{ applied: number; failed: number; sections: string[] }>(`/api/chapters/${row.id}/revise/apply`, { method: "POST", json: { changes }, signal: ctrl.signal });
          if (a.sections.length) onApplied(a.sections);
          total += a.applied;
          set(row.id, { state: "done", note: `${a.applied}개 적용${a.failed ? ` · ${a.failed}개는 원고가 달라 건너뜀` : ""}` });
        } catch (e: any) {
          if (ctrl.signal.aborted) {
            set(row.id, { state: "wait", note: "멈춤" });
            break;
          }
          if (String(e.message).includes(EMPTY_CHAPTER)) set(row.id, { state: "skip", note: "본문이 거의 없음" });
          else set(row.id, { state: "fail", note: e.message });
        }
      }
    } finally {
      abortRef.current = null;
      setAllRunning(false);
    }
    setMsg(
      stopRef.current
        ? `멈췄습니다. 지금까지 ${total}개를 적용했습니다.`
        : `전체 장 퇴고를 마쳤습니다. ${total}개를 적용했습니다. 절마다 적용 전 원고가 버전 기록(장 퇴고 전)에 있습니다.`,
    );
  };

  const stopAll = () => {
    stopRef.current = true;
    abortRef.current?.abort();
  };
  const retryIds = new Set(rows?.filter((r) => r.state === "fail" || (r.state === "wait" && r.note)).map((r) => r.id) ?? []);

  const run = async () => {
    setBusy("run");
    setMsg("");
    try {
      if (!(await beforeRun())) throw new Error("원고 저장을 완료한 뒤 다시 시도하세요.");
      const r = await api<{ overview: string; changes: Change[]; failed: Change[] }>(`/api/chapters/${chapterId}/revise`, { method: "POST", json: { focus } });
      setPlan(r);
      setPicked(new Set(r.changes.map((_, i) => i)));
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy("");
    }
  };

  const apply = async () => {
    if (!plan || !picked.size) return;
    setBusy("apply");
    try {
      if (!(await beforeRun())) throw new Error("원고 저장을 완료한 뒤 다시 시도하세요.");
      const changes = plan.changes.filter((_, i) => picked.has(i)).map(({ sectionId, paragraph, before, after }) => ({ sectionId, paragraph, before, after }));
      const r = await api<{ applied: number; failed: number; sections: string[] }>(`/api/chapters/${chapterId}/revise/apply`, { method: "POST", json: { changes } });
      onApplied(r.sections);
      setMsg(`${r.applied}개를 적용했습니다${r.failed ? ` (${r.failed}개는 원고가 달라 건너뜀)` : ""}. 절마다 적용 전 원고가 버전 기록(장 퇴고 전)에 있습니다.`);
      setPlan(null);
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-6" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
          <h2 className="font-semibold">장 단위 퇴고 — {rows && !plan ? "전체 장" : chapterName}</h2>
          <button className="btn-ghost" disabled={running} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="space-y-2 border-b border-stone-200 p-4">
          <p className="text-xs leading-5 text-stone-600">
            장 전체를 한 번에 읽고 <b>절 사이 중복</b>, <b>절과 절의 연결</b>, <b>장의 흐름과 맺음</b>, <b>용어·호칭 통일</b>을 봅니다. 맞춤법은 절마다 [교정·교열]을 쓰세요. 수정안은 고른 것만 적용됩니다.
          </p>
          <div className="flex gap-2">
            <input className="input flex-1 text-sm" placeholder="특히 볼 것 (선택) — 예: 2절과 4절 사례가 겹치는 것 같다" value={focus} onChange={(e) => setFocus(e.target.value)} />
            <button className="btn-accent" disabled={running} onClick={run} title="지금 장만 퇴고안을 만들고, 고른 것만 적용합니다">
              {busy === "run" ? "장 전체 읽는 중… (1~3분)" : plan ? "다시 만들기" : "퇴고안 만들기"}
            </button>
            {allRunning ? (
              <button className="btn-primary bg-red-700 hover:bg-red-800" onClick={stopAll} title="진행 중인 장을 멈춥니다 — 이미 적용한 장은 그대로 둡니다">
                ■ 멈추기
              </button>
            ) : (
              <button className="btn" disabled={running || !chapters.length} onClick={() => runAll()} title="첫 장부터 마지막 장까지 차례로 퇴고안을 만들어 모두 적용합니다">
                전체 장 퇴고
              </button>
            )}
          </div>
          {focus && <p className="text-[11px] text-stone-400">전체 장 퇴고에서는 &lsquo;특히 볼 것&rsquo;이 모든 장에 똑같이 적용됩니다.</p>}
          {msg && <p className="text-sm text-amber-800">{msg}</p>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
          {rows && !plan && (
            <>
              <ol className="space-y-1">
                {rows.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 rounded-lg border border-stone-200 px-3 py-1.5 text-xs">
                    <span
                      className={`w-28 shrink-0 font-semibold ${
                        r.state === "done" ? "text-green-700" : r.state === "fail" ? "text-red-700" : r.state === "plan" || r.state === "apply" ? "text-amber-700" : "text-stone-400"
                      }`}
                    >
                      {STATE[r.state]}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-stone-700">{r.name}</span>
                    {r.note && (
                      <span className="max-w-[45%] truncate text-stone-500" title={r.note}>
                        {r.note}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
              {!allRunning && retryIds.size > 0 && (
                <button className="btn mt-3 text-xs" onClick={() => runAll(retryIds)}>
                  실패·멈춘 장 {retryIds.size}개 다시
                </button>
              )}
            </>
          )}
          {plan && (
            <>
              {plan.overview && <p className="mb-3 rounded-lg bg-stone-50 p-3 text-xs leading-5 text-stone-700">{plan.overview}</p>}
              {!plan.changes.length && <p className="py-6 text-center text-stone-500">고칠 곳을 찾지 못했습니다.</p>}
              <div className="space-y-2">
                {plan.changes.map((c, i) => (
                  <label key={i} className={`block cursor-pointer rounded-lg border p-2 ${picked.has(i) ? "border-amber-300 bg-amber-50/40" : "border-stone-200"}`}>
                    <div className="mb-1 flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={picked.has(i)}
                        onChange={(e) => {
                          const n = new Set(picked);
                          if (e.target.checked) n.add(i);
                          else n.delete(i);
                          setPicked(n);
                        }}
                      />
                      <span className="rounded bg-stone-200 px-1.5 text-[10px]">{TYPE[c.type] ?? c.type}</span>
                      <span className="font-semibold text-stone-700">
                        {c.sectionLabel} {c.sectionTitle}
                      </span>
                      <span className="text-stone-400">{c.paragraph}번째 문단</span>
                    </div>
                    <div className="text-xs leading-5">
                      <del className="text-red-700/80">{c.before}</del>
                      <div className="text-green-800">{c.after || <i className="text-stone-400">(삭제)</i>}</div>
                      {c.reason && <div className="mt-0.5 text-[11px] text-stone-500">— {c.reason}</div>}
                    </div>
                  </label>
                ))}
              </div>
              {plan.failed.length > 0 && <p className="mt-3 text-[11px] text-stone-400">원문과 정확히 맞지 않아 뺀 수정안 {plan.failed.length}개</p>}
            </>
          )}
        </div>
        {plan && plan.changes.length > 0 && (
          <div className="flex items-center gap-2 border-t border-stone-200 px-4 py-3">
            <button className="btn-ghost text-xs" onClick={() => setPicked(new Set(plan.changes.map((_, i) => i)))}>
              모두 고르기
            </button>
            <button className="btn-ghost text-xs" onClick={() => setPicked(new Set())}>
              모두 해제
            </button>
            <button className="btn-primary ml-auto" disabled={running || !picked.size} onClick={apply}>
              {busy === "apply" ? "적용 중…" : `고른 ${picked.size}개 적용`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
