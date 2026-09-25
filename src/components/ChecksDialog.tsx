"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";

type Marker = { paragraph: number; offset: number; footnote?: number; marker: string; kind: "check" | "image"; before: string; after: string };
type Result = { total: number; sections: { sectionId: string; label: string; title: string; chapterTitle: string; markers: Marker[] }[] };

/**
 * [확인 필요]·[이미지 제안] 관리 — AI가 확신 없이 쓴 수치·사실을 작가가 하나씩 확인한다.
 * 확인함: 표시만 지운다 · 출처를 각주로: 입력한 출처·설명을 그 자리에 각주로 달고 표시를 지운다.
 */
export default function ChecksDialog({
  projectId,
  onClose,
  onGoto,
  beforeEdit,
  onEdited,
  onCount,
}: {
  projectId: string;
  onClose: () => void;
  onGoto: (sectionId: string, paragraph: number, text: string) => void;
  beforeEdit: () => Promise<boolean>;
  onEdited: (sectionIds: string[]) => void;
  onCount: (n: number) => void;
}) {
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState<"all" | "check" | "image">("all");

  const load = async () => {
    setErr("");
    try {
      if (!(await beforeEdit())) throw new Error("저장을 완료하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
      const r = await api<Result>(`/api/projects/${projectId}/checks`);
      setRes(r);
      onCount(r.total);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (sectionId: string, m: Marker, action: "remove" | "footnote") => {
    const key = `${sectionId}:${m.paragraph}:${m.offset}:${m.footnote ?? ""}`;
    setBusy(key);
    try {
      if (!(await beforeEdit())) throw new Error("저장을 완료하지 못했습니다.");
      await api(`/api/projects/${projectId}/checks`, { method: "POST", json: { sectionId, ...m, action, note: action === "footnote" ? note : undefined } });
      setOpen(null);
      setNote("");
      onEdited([sectionId]);
      await load();
    } catch (e: any) {
      alert(e.message);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const shown = res?.sections
    .map((s) => ({ ...s, markers: s.markers.filter((m) => kind === "all" || m.kind === kind) }))
    .filter((s) => s.markers.length);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-2xl">
        <div className="flex items-center gap-3 border-b border-stone-200 px-4 py-3">
          <h2 className="font-semibold">확인할 것 {res ? `(${res.total})` : ""}</h2>
          <div className="flex overflow-hidden rounded-md border border-stone-300 text-xs">
            {(
              [
                ["all", "전체"],
                ["check", "확인 필요"],
                ["image", "이미지 제안"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} className={`px-2 py-1 ${kind === k ? "bg-stone-800 text-white" : ""}`} onClick={() => setKind(k)}>
                {l}
              </button>
            ))}
          </div>
          <button className="btn-ghost ml-auto text-xs" onClick={load}>
            ↻ 새로 고침
          </button>
          <button className="btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="border-b border-stone-100 px-4 py-2 text-[11px] leading-4 text-stone-500">
          AI가 확신 없는 수치·사실 뒤에 남긴 표시입니다. 사실을 확인했으면 [확인함], 근거를 책에 남기려면 [출처를 각주로]를 누르세요. 처리 전 원고는 버전 기록에 남습니다. 인쇄 전에 모두 처리하세요.
        </p>
        <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
          {err && <p className="text-red-600">{err}</p>}
          {!res && !err && <p className="text-stone-400">불러오는 중…</p>}
          {shown && !shown.length && <p className="py-8 text-center text-stone-500">남은 표시가 없습니다. 🎉</p>}
          <div className="space-y-3">
            {shown?.map((s) => (
              <div key={s.sectionId} className="rounded-lg border border-stone-200">
                <div className="border-b border-stone-100 bg-stone-50 px-3 py-1.5 text-xs font-semibold text-stone-700">
                  {s.label} {s.title} <span className="font-normal text-stone-400">· {s.chapterTitle}</span>
                </div>
                <ul className="divide-y divide-stone-100">
                  {s.markers.map((m) => {
                    const key = `${s.sectionId}:${m.paragraph}:${m.offset}:${m.footnote ?? ""}`;
                    return (
                      <li key={key} className="px-3 py-2">
                        <div className="text-xs leading-5">
                          <span className="text-stone-500">…{m.before}</span>
                          <mark className={m.kind === "check" ? "bg-red-100 text-red-800" : "bg-sky-100 text-sky-800"}>{m.marker}</mark>
                          <span className="text-stone-400">{m.after}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-2 text-[11px]">
                          <button className="text-stone-600 hover:underline" onClick={() => onGoto(s.sectionId, m.paragraph, m.marker)}>
                            위치로
                          </button>
                          <button className="text-green-700 hover:underline disabled:opacity-40" disabled={!!busy} onClick={() => act(s.sectionId, m, "remove")}>
                            {busy === key ? "처리 중…" : m.kind === "check" ? "확인함 (표시 지우기)" : "표시 지우기"}
                          </button>
                          {m.kind === "check" && m.offset >= 0 && (
                            <button className="text-violet-700 hover:underline" onClick={() => setOpen(open === key ? null : key)}>
                              출처를 각주로
                            </button>
                          )}
                        </div>
                        {open === key && (
                          <div className="mt-2 flex gap-2">
                            <input
                              autoFocus
                              className="input flex-1 text-xs"
                              placeholder="예: 통계청, 「2025 인구동향」(2025.3)"
                              value={note}
                              onChange={(e) => setNote(e.target.value)}
                              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && note.trim() && act(s.sectionId, m, "footnote")}
                            />
                            <button className="btn-primary px-2 py-1 text-xs" disabled={!note.trim() || !!busy} onClick={() => act(s.sectionId, m, "footnote")}>
                              각주로 달기
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
