"use client";

import { useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client";
import { diffParagraphs, docParagraphs, parseDoc, type JNode } from "@/lib/doc/doc";

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
};

type V = { id: string; reason: string; charCount: number; createdAt: string };

export default function VersionsPanel({
  sectionId,
  refreshKey,
  getCurrent,
  onRestore,
  onSnapshot,
  beforeRestore,
}: {
  sectionId: string;
  refreshKey: number;
  getCurrent: () => JNode;
  onRestore: (content: string) => void;
  onSnapshot: () => Promise<void>;
  beforeRestore: () => Promise<boolean>;
}) {
  const [list, setList] = useState<V[]>([]);
  const [view, setView] = useState<{ v: V; rows: ReturnType<typeof diffParagraphs> } | null>(null);
  const load = () => api<V[]>(`/api/sections/${sectionId}/versions`).then(setList);
  useEffect(() => {
    load();
    setView(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId, refreshKey]);

  const open = async (v: V) => {
    const full = await api<{ content: string }>(`/api/versions/${v.id}`);
    setView({ v, rows: diffParagraphs(docParagraphs(parseDoc(full.content)), docParagraphs(getCurrent())) });
  };

  const restore = async (v: V) => {
    if (!confirm(`${fmtDate(v.createdAt)} 버전(${REASON[v.reason] ?? v.reason})으로 되돌릴까요? 지금 내용은 버전 기록에 남습니다.`)) return;
    if (!await beforeRestore()) return alert("현재 원고 저장을 완료한 뒤 복원해주세요.");
    const r = await api<{ content: string }>(`/api/versions/${v.id}`, { method: "POST", json: { currentContent: JSON.stringify(getCurrent()) } });
    onRestore(r.content);
    setView(null);
    load();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-stone-200 px-3 py-2">
        <span className="text-xs text-stone-500">편집 중 5분 간격 · AI 작업 전 보관</span>
        <button
          className="btn-ghost text-xs"
          onClick={async () => {
            await onSnapshot();
            load();
          }}
        >
          + 지금 스냅샷
        </button>
      </div>
      {view ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-stone-100 px-3 py-2 text-xs">
            <button className="btn-ghost text-xs" onClick={() => setView(null)}>
              ← 목록
            </button>
            <button className="btn-primary px-2 py-1 text-xs" onClick={() => restore(view.v)}>
              이 버전으로 복원
            </button>
          </div>
          <p className="px-3 py-1 text-[11px] text-stone-500">
            <span className="bg-red-100 px-1">빨강</span> = 이 버전에만 있음, <span className="bg-emerald-100 px-1">초록</span> = 지금 내용에만 있음
          </p>
          <div className="min-h-0 flex-1 space-y-1 overflow-auto px-3 pb-3 font-book text-[12px] leading-5">
            {view.rows.map((r, i) => (
              <p key={i} className={r.type === "del" ? "bg-red-50 text-red-800 line-through decoration-red-300" : r.type === "add" ? "bg-emerald-50 text-emerald-900" : "text-stone-400"}>
                {r.type === "same" ? (r.text.length > 60 ? r.text.slice(0, 60) + "…" : r.text) : r.text}
              </p>
            ))}
          </div>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-stone-100 overflow-auto">
          {list.length === 0 && <li className="p-4 text-center text-xs text-stone-400">아직 버전이 없습니다</li>}
          {list.map((v) => (
            <li key={v.id} className="flex items-center justify-between px-3 py-2 text-xs hover:bg-stone-50">
              <button className="flex-1 text-left" onClick={() => open(v)}>
                <div className="font-medium text-stone-700">{REASON[v.reason] ?? v.reason}</div>
                <div className="text-stone-400">
                  {fmtDate(v.createdAt)} · {v.charCount.toLocaleString()}자
                </div>
              </button>
              <button className="btn-ghost text-xs" onClick={() => restore(v)}>
                복원
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
