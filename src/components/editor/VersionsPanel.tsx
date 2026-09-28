"use client";

import { useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client";
import { docParagraphs, parseDoc, type JNode } from "@/lib/doc/doc";
import { ParagraphDiff } from "@/components/InlineDiff";
import { confirmDialog, toast, toastError } from "@/components/ui/feedback";
import ReviseRunView, { type ReviseRun } from "./ReviseRunView";

const REASON: Record<string, string> = {
  autosave: "자동 저장 이전 원고",
  ai_write: "AI 집필 전",
  proofread: "교정 적용 전",
  manual: "수동 스냅샷",
  restore: "복원 전",
  length_adjust: "분량 조정 전",
  rewrite: "부분 수정 전",
  footnote: "자동 각주 전",
  ai_output: "AI 초안 원본",
  replace: "책 전체 바꾸기 전",
  check: "확인 표시 처리 전",
  chapter_revise: "장 퇴고 전",
  revise_undo: "장 퇴고 되돌리기 전",
  factcheck: "AI 사실 확인 전",
  conflict: "저장 충돌 때 고르지 않은 원고",
};

type V = { id: string; reason: string; charCount: number; createdAt: string; revise?: { here: number; total: number } };

export default function VersionsPanel({
  sectionId,
  refreshKey,
  getCurrent,
  onRestore,
  onSnapshot,
  beforeRestore,
  onServerEdited,
  lockReason,
}: {
  sectionId: string;
  refreshKey: number;
  getCurrent: () => JNode;
  onRestore: (content: string) => void;
  onSnapshot: () => Promise<void>;
  beforeRestore: () => Promise<boolean>;
  /** 서버가 이 절(과 같은 장의 다른 절)을 고친 뒤 — 편집기가 다시 불러온다 */
  onServerEdited?: () => void;
  /** 절이 잠긴 이유 (AI 집필·교정 등) — 그동안은 복원하지 않는다 */
  lockReason?: string;
}) {
  const [list, setList] = useState<V[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [view, setView] = useState<{
    v: V;
    before: string[];
    after: string[];
    /** 장 퇴고 버전이면 그때의 퇴고 기록 */
    revise: ReviseRun | null;
    mode: "revise" | "diff";
  } | null>(null);
  const load = () =>
    api<V[]>(`/api/sections/${sectionId}/versions`)
      .then((l) => {
        setList(l);
        setLoadErr("");
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    load();
    setView(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId, refreshKey]);

  const open = async (v: V) => {
    try {
      const full = await api<{ content: string; revise?: ReviseRun }>(`/api/versions/${v.id}`);
      setView({
        v,
        before: docParagraphs(parseDoc(full.content)),
        after: docParagraphs(getCurrent()),
        revise: full.revise ?? null,
        mode: full.revise ? "revise" : "diff",
      });
    } catch (e) {
      toastError(e, "버전을 불러오지 못했습니다: ");
    }
  };

  const restore = async (v: V) => {
    if (lockReason) return toast.error(`${lockReason} — 끝난 뒤에 복원하세요.`);
    if (!(await confirmDialog(`${fmtDate(v.createdAt)} 버전(${REASON[v.reason] ?? v.reason})으로 되돌릴까요? 지금 내용은 버전 기록에 남습니다.`, { okLabel: "복원" }))) return;
    if (!(await beforeRestore())) return toast.error("현재 원고 저장을 완료한 뒤 복원해주세요.");
    try {
      const r = await api<{ content: string }>(`/api/versions/${v.id}`, {
        method: "POST",
        json: { currentContent: JSON.stringify(getCurrent()) },
      });
      onRestore(r.content);
      setView(null);
      load();
      toast("이전 버전으로 복원했습니다.");
    } catch (e) {
      toastError(e, "복원하지 못했습니다: ");
    }
  };

  /** 한 번의 장 퇴고를 모든 절에서 되돌린다 */
  const undoRevise = async (run: ReviseRun) => {
    if (lockReason) return void toast.error(`${lockReason} — 끝난 뒤에 되돌리세요.`);
    const n = run.sections.length;
    if (!(await confirmDialog(`${fmtDate(run.at)} 장 퇴고(${run.total}곳${n > 1 ? `, ${n}개 절` : ""})를 되돌릴까요? 그 뒤 고친 절은 퇴고로 바뀐 문장만 되돌리고 나중에 고친 곳은 그대로 둡니다. 되돌리기 전 원고는 버전 기록에 남습니다.`, { okLabel: "되돌리기" }))) return;
    if (!(await beforeRestore())) return void toast.error("현재 원고 저장을 완료한 뒤 되돌려주세요.");
    try {
      const r = await api<{ sections: string[]; restored: number; reverted: number; failed: number }>(`/api/chapters/${run.chapterId}/revise/undo`, { method: "POST", json: { runId: run.runId } });
      toast.success(`장 퇴고를 되돌렸습니다 — ${r.reverted}곳${r.failed ? ` (원고가 달라 ${r.failed}곳은 그대로 둠)` : ""}.`);
      setView(null);
      onServerEdited?.();
      load();
    } catch (e) {
      toastError(e, "되돌리지 못했습니다: ");
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-stone-200 px-3 py-2">
        <span className="text-xs text-stone-500">편집 중 5분 간격 · AI 작업 전 보관</span>
        <button
          className="btn-ghost text-xs"
          onClick={async () => {
            try {
              await onSnapshot();
              toast("지금 원고를 버전 기록에 남겼습니다.");
            } catch (e) {
              toastError(e, "스냅샷을 남기지 못했습니다: ");
            }
            load();
          }}
        >
          + 지금 스냅샷
        </button>
      </div>
      {loadErr && (
        <p className="border-b border-red-100 bg-red-50 px-3 py-1.5 text-[11px] text-red-700">
          버전 목록을 불러오지 못했습니다: {loadErr}{" "}
          <button className="underline" onClick={load}>
            다시
          </button>
        </p>
      )}
      {lockReason && <p className="border-b border-stone-100 bg-stone-50 px-3 py-1.5 text-[11px] text-stone-500">{lockReason} — 끝날 때까지 복원할 수 없습니다.</p>}
      {view ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-stone-100 px-3 py-2 text-xs">
            <button className="btn-ghost text-xs" onClick={() => setView(null)}>
              ← 목록
            </button>
            <button className="btn-primary px-2 py-1 text-xs" disabled={!!lockReason} title={lockReason || undefined} onClick={() => restore(view.v)}>
              이 버전으로 복원
            </button>
          </div>
          {view.revise && (
            <div className="flex gap-1 border-b border-stone-100 px-3 py-1.5 text-[11px]">
              {(
                [
                  ["revise", `이때 고친 곳 (장 전체 ${view.revise.total})`],
                  ["diff", "이 버전과 지금 원고 비교"],
                ] as const
              ).map(([k, label]) => (
                <button key={k} className={`rounded px-2 py-0.5 ${view.mode === k ? "bg-stone-800 text-white" : "text-stone-600 hover:bg-stone-100"}`} onClick={() => setView({ ...view, mode: k })}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {view.revise && view.mode === "revise" ? (
            <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
              <p className="mb-2 text-[11px] text-stone-500">
                이 퇴고가 장 안의 절들에서 바꾼 곳입니다. <span className="bg-red-100 px-1 line-through">빨강</span> = 지운 글, <span className="bg-emerald-100 px-1 underline">초록</span> = 새로 쓴 글. [이 버전으로 복원]은 이 절만 되돌립니다.
              </p>
              <ReviseRunView run={view.revise} currentSectionId={sectionId} onUndo={lockReason ? undefined : undoRevise} compact />
            </div>
          ) : (
            <>
              <p className="px-3 py-1 text-[11px] text-stone-500">
                <span className="bg-red-100 px-1 line-through">빨강</span> = 이 버전에만 있음, <span className="bg-emerald-100 px-1 underline">초록</span> = 지금 내용에만 있음{view.revise ? " (그 뒤 고친 것까지 함께 보입니다)" : ""}
              </p>
              <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
                <ParagraphDiff key={view.v.id} before={view.before} after={view.after} />
              </div>
            </>
          )}
        </div>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-stone-100 overflow-auto">
          {list.length === 0 && <li className="p-4 text-center text-xs text-stone-400">아직 버전이 없습니다</li>}
          {list.map((v) => (
            <li key={v.id} className="flex items-center justify-between px-3 py-2 text-xs hover:bg-stone-50">
              <button className="flex-1 text-left" onClick={() => open(v)}>
                <div className="font-medium text-stone-700">
                  {REASON[v.reason] ?? v.reason}
                  {v.revise && (
                    <span className="ml-1.5 font-normal text-amber-700">
                      {v.revise.total > v.revise.here ? `이 절 ${v.revise.here}곳 · 장 전체 ${v.revise.total}곳` : `${v.revise.here}곳 수정`}
                    </span>
                  )}
                </div>
                <div className="text-stone-400">
                  {fmtDate(v.createdAt)} · {v.charCount.toLocaleString()}자
                </div>
              </button>
              <button className="btn-ghost text-xs disabled:opacity-40" disabled={!!lockReason} title={lockReason || undefined} onClick={() => restore(v)}>
                복원
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
