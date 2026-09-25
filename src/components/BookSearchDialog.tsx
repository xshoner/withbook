"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { confirmDialog } from "./ui/feedback";

type Hit = { paragraph: number; offset: number; before: string; match: string; after: string };
type Result = { total: number; sections: { sectionId: string; label: string; title: string; chapterTitle: string; hits: Hit[] }[] };

/** 책 전체 찾기·바꾸기 — 바꾸기 전 원고는 절마다 버전 기록에 남는다 */
export default function BookSearchDialog({
  projectId,
  initialQuery,
  onClose,
  onGoto,
  beforeEdit,
  onEdited,
}: {
  projectId: string;
  initialQuery: string;
  onClose: () => void;
  onGoto: (sectionId: string, paragraph: number, text: string) => void;
  beforeEdit: () => Promise<boolean>;
  onEdited: (sectionIds: string[]) => void;
}) {
  const [q, setQ] = useState(initialQuery);
  const [rep, setRep] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const search = async (query = q) => {
    if (!query.trim()) return;
    setBusy(true);
    setMsg("");
    try {
      if (!(await beforeEdit())) throw new Error("저장을 완료하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
      const r = await api<Result>(`/api/projects/${projectId}/search?q=${encodeURIComponent(query)}`);
      setRes(r);
      setPicked(new Set(r.sections.map((s) => s.sectionId)));
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (initialQuery.trim()) search(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const replace = async () => {
    if (!res || !picked.size) return;
    const n = res.sections.filter((s) => picked.has(s.sectionId)).reduce((a, s) => a + s.hits.length, 0);
    if (!(await confirmDialog(`${picked.size}개 절에서 "${q}" ${n}곳을 "${rep}"(으)로 바꿀까요? 바꾸기 전 원고는 각 절의 버전 기록에 남습니다.`, { okLabel: "모두 바꾸기" }))) return;
    setBusy(true);
    try {
      if (!(await beforeEdit())) throw new Error("저장을 완료하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
      const r = await api<{ count: number; sections: string[] }>(`/api/projects/${projectId}/replace`, {
        method: "POST",
        json: { query: q, replacement: rep, sectionIds: [...picked] },
      });
      onEdited(r.sections);
      setMsg(`${r.sections.length}개 절에서 ${r.count}곳을 바꿨습니다.`);
      setRes(null);
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3">
          <h2 className="font-semibold">책 전체 찾기·바꾸기</h2>
          <button className="btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="space-y-2 border-b border-stone-200 p-4">
          <div className="flex gap-2">
            <input
              autoFocus
              className="input flex-1"
              placeholder="찾을 말"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && search()}
            />
            <button className="btn-primary" disabled={busy || !q.trim()} onClick={() => search()}>
              찾기
            </button>
          </div>
          <div className="flex gap-2">
            <input className="input flex-1" placeholder="바꿀 말 (비우면 지웁니다)" value={rep} onChange={(e) => setRep(e.target.value)} />
            <button className="btn" disabled={busy || !res?.total || !picked.size} onClick={replace}>
              고른 절 모두 바꾸기
            </button>
          </div>
          <p className="text-[11px] text-stone-500">
            대소문자·띄어쓰기까지 정확히 같은 말만 찾습니다. 굵게·각주 같은 서식은 유지됩니다. 지금 여는 절도 저장한 뒤 바꾸고 다시 불러옵니다.
          </p>
          {msg && <p className="text-sm text-amber-800">{msg}</p>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
          {busy && <p className="text-stone-400">처리 중…</p>}
          {res && !busy && (
            <>
              <p className="mb-2 text-xs text-stone-500">
                {res.total ? `${res.sections.length}개 절에서 ${res.total}곳` : "찾은 결과가 없습니다."}
              </p>
              <div className="space-y-3">
                {res.sections.map((s) => (
                  <div key={s.sectionId} className="rounded-lg border border-stone-200">
                    <label className="flex items-center gap-2 border-b border-stone-100 bg-stone-50 px-3 py-1.5 text-xs font-semibold text-stone-700">
                      <input
                        type="checkbox"
                        checked={picked.has(s.sectionId)}
                        onChange={(e) => {
                          const n = new Set(picked);
                          if (e.target.checked) n.add(s.sectionId);
                          else n.delete(s.sectionId);
                          setPicked(n);
                        }}
                      />
                      {s.label} {s.title}
                      <span className="ml-auto font-normal text-stone-400">{s.hits.length}곳</span>
                    </label>
                    <ul className="divide-y divide-stone-100">
                      {s.hits.map((h, i) => (
                        <li key={i}>
                          <button className="w-full px-3 py-1.5 text-left text-xs hover:bg-amber-50" onClick={() => onGoto(s.sectionId, h.paragraph, h.match)}>
                            <span className="text-stone-400">…{h.before}</span>
                            <mark className="bg-amber-200">{h.match}</mark>
                            <span className="text-stone-400">{h.after}…</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
