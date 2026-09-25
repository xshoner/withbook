"use client";

import { useState } from "react";
import { api } from "@/lib/client";

type Change = { sectionId: string; sectionLabel: string; sectionTitle: string; paragraph: number; before: string; after: string; type: string; reason: string };

const TYPE: Record<string, string> = { duplicate: "중복", transition: "연결", flow: "흐름", consistency: "통일" };

/** 장 단위 퇴고 — 장 전체를 읽고 절 사이 중복·연결·흐름을 고치는 수정안을 받아, 고른 것만 적용한다 */
export default function ChapterReviseDialog({
  chapterId,
  chapterName,
  beforeRun,
  onApplied,
  onClose,
}: {
  chapterId: string;
  chapterName: string;
  beforeRun: () => Promise<boolean>;
  onApplied: (sectionIds: string[]) => void;
  onClose: () => void;
}) {
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState<"" | "run" | "apply">("");
  const [plan, setPlan] = useState<{ overview: string; changes: Change[]; failed: Change[] } | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState("");

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
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-6" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
          <h2 className="font-semibold">장 단위 퇴고 — {chapterName}</h2>
          <button className="btn-ghost" disabled={!!busy} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="space-y-2 border-b border-stone-200 p-4">
          <p className="text-xs leading-5 text-stone-600">
            장 전체를 한 번에 읽고 <b>절 사이 중복</b>, <b>절과 절의 연결</b>, <b>장의 흐름과 맺음</b>, <b>용어·호칭 통일</b>을 봅니다. 맞춤법은 절마다 [교정·교열]을 쓰세요. 수정안은 고른 것만 적용됩니다.
          </p>
          <div className="flex gap-2">
            <input className="input flex-1 text-sm" placeholder="특히 볼 것 (선택) — 예: 2절과 4절 사례가 겹치는 것 같다" value={focus} onChange={(e) => setFocus(e.target.value)} />
            <button className="btn-accent" disabled={!!busy} onClick={run}>
              {busy === "run" ? "장 전체 읽는 중… (1~3분)" : plan ? "다시 만들기" : "퇴고안 만들기"}
            </button>
          </div>
          {msg && <p className="text-sm text-amber-800">{msg}</p>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
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
            <button className="btn-primary ml-auto" disabled={!!busy || !picked.size} onClick={apply}>
              {busy === "apply" ? "적용 중…" : `고른 ${picked.size}개 적용`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
