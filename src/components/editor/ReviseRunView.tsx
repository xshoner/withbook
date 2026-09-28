"use client";

import { useState } from "react";
import { fmtDate } from "@/lib/client";
import InlineDiff from "@/components/InlineDiff";

export type ReviseChangeLog = { paragraph: number; before: string; after: string; type: string; reason: string };
export type ReviseSectionLog = { sectionId: string; label: string; title: string; versionId: string | null; changes: ReviseChangeLog[] };
export type ReviseRun = {
  runId: string;
  chapterId: string;
  chapterName: string;
  at: string;
  focus: string;
  total: number;
  sections: ReviseSectionLog[];
  undoneAt?: string;
  undo?: { restored: number; reverted: number; failed: number };
};

export const REVISE_TYPE: Record<string, string> = { duplicate: "중복", transition: "연결", flow: "흐름", consistency: "통일" };

/**
 * 한 번의 장 퇴고로 바뀐 곳 — 장 안의 모든 절을 절 순서대로, 문단마다 바뀐 어절만 빨강(지움)·초록(새로 씀)으로.
 * currentSectionId: 지금 편집 중인 절(맨 위에 두고 강조). onUndo가 있으면 [이 퇴고 되돌리기]를 보인다.
 */
export default function ReviseRunView({
  run,
  currentSectionId,
  onUndo,
  compact = false,
}: {
  run: ReviseRun;
  currentSectionId?: string;
  onUndo?: (run: ReviseRun) => Promise<void>;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const sections = currentSectionId ? [...run.sections].sort((a, b) => Number(b.sectionId === currentSectionId) - Number(a.sectionId === currentSectionId)) : run.sections;
  const here = run.sections.find((s) => s.sectionId === currentSectionId)?.changes.length ?? 0;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-stone-600">
        {!compact && <span className="font-semibold text-stone-800">{run.chapterName}</span>}
        <span>{fmtDate(run.at)}</span>
        <span>
          · 장 전체 <b>{run.total}곳</b> ({run.sections.length}개 절){currentSectionId && run.sections.length > 1 ? ` · 이 절 ${here}곳` : ""}
        </span>
        {run.undoneAt && (
          <span className="rounded bg-stone-200 px-1.5 text-[10px] text-stone-600" title={run.undo ? `되돌림 ${run.undo.reverted}곳${run.undo.failed ? ` · 원고가 달라 못 되돌린 곳 ${run.undo.failed}` : ""}` : undefined}>
            {fmtDate(run.undoneAt)} 되돌림
          </span>
        )}
        {onUndo && !run.undoneAt && (
          <button
            className="btn-ghost ml-auto px-1.5 py-0.5 text-[11px] text-red-700"
            disabled={busy}
            title="이 퇴고로 바뀐 곳을 모든 절에서 되돌립니다. 그 뒤 고친 절은 퇴고로 바뀐 문장만 되돌리고 나중에 고친 곳은 지킵니다."
            onClick={async () => {
              setBusy(true);
              try {
                await onUndo(run);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "되돌리는 중…" : "이 퇴고 되돌리기"}
          </button>
        )}
      </div>
      {run.focus && <p className="text-[11px] text-stone-500">특히 볼 것: {run.focus}</p>}
      {sections.map((s) => {
        const cur = s.sectionId === currentSectionId;
        return (
          <section key={s.sectionId} className={`rounded-lg border ${cur ? "border-amber-300 bg-amber-50/40" : "border-stone-200"}`}>
            <h4 className="flex items-center gap-2 border-b border-stone-100 px-2 py-1 font-semibold text-stone-700">
              <span className="min-w-0 truncate">
                {s.label} {s.title}
              </span>
              {cur && <span className="rounded bg-amber-200 px-1 text-[10px] font-normal text-amber-900">이 절</span>}
              <span className="ml-auto shrink-0 font-normal text-stone-400">{s.changes.length}곳</span>
            </h4>
            <ol className="divide-y divide-stone-100">
              {s.changes.map((c, i) => (
                <li key={i} className="px-2 py-1.5">
                  <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-stone-500">
                    {c.type && <span className="rounded bg-stone-200 px-1">{REVISE_TYPE[c.type] ?? c.type}</span>}
                    <span>{c.paragraph}번째 문단</span>
                  </div>
                  <p className="font-book text-[12px] leading-5 text-stone-800">
                    {c.after ? <InlineDiff before={c.before} after={c.after} /> : <span className="bg-red-100 text-red-800 line-through decoration-red-400">{c.before}</span>}
                    {!c.after && <span className="ml-1 font-sans text-[10px] text-stone-400">(삭제)</span>}
                  </p>
                  {c.reason && <p className="mt-0.5 text-[11px] text-stone-500">— {c.reason}</p>}
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
