"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { toast, toastError } from "@/components/ui/feedback";
import type { TrashMeta } from "@/lib/trash";

/** 지운 장·절 목록 — 30일 동안 보관, [되돌리기]로 원래 자리에 복원 */
export default function TrashDialog({ projectId, onClose, onRestored }: { projectId: string; onClose: () => void; onRestored: () => void }) {
  const [items, setItems] = useState<TrashMeta[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: TrashMeta[] }>(`/api/projects/${projectId}/toc?trash=1`);
      setItems(r.items);
    } catch (e) {
      toastError(e, "휴지통을 읽지 못했습니다: ");
      setItems([]);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const restore = async (m: TrashMeta) => {
    setBusy(m.id);
    try {
      const r = await api<{ versionsDropped?: boolean }>(`/api/projects/${projectId}/toc`, { method: "PATCH", json: { op: "restoreTrash", trashId: m.id } });
      toast.success(`「${m.title}」을(를) 되돌렸습니다${r.versionsDropped ? " (용량이 커서 버전 기록은 보관하지 않았습니다)" : ""}`);
      setItems((xs) => xs?.filter((x) => x.id !== m.id) ?? xs);
      onRestored();
    } catch (e) {
      toastError(e, "되돌리지 못했습니다: ");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="삭제한 장·절" className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl bg-white shadow-2xl">
        <div className="flex items-center gap-3 border-b border-stone-200 px-4 py-3">
          <h2 className="font-semibold">삭제한 장·절</h2>
          <span className="text-xs text-stone-500">30일 동안 보관한 뒤 자동으로 지웁니다</span>
          <button className="btn-ghost ml-auto" aria-label="닫기" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {items === null && <div className="p-6 text-center text-sm text-stone-500">불러오는 중…</div>}
          {items?.length === 0 && <div className="p-6 text-center text-sm text-stone-500">삭제한 장·절이 없습니다.</div>}
          <ul>
            {items?.map((m) => (
              <li key={m.id} className="flex items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-stone-50">
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${m.kind === "chapter" ? "bg-stone-800 text-white" : "bg-stone-100 text-stone-600"}`}>{m.kind === "chapter" ? "장" : "절"}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate" title={m.title}>
                    {m.label && <span className="mr-1 text-xs text-stone-400">{m.label}</span>}
                    {m.title}
                  </div>
                  <div className="text-[11px] text-stone-400">
                    {new Date(m.deletedAt).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })} 삭제 · {m.charCount.toLocaleString()}자
                    {m.versionsDropped && " · 버전 기록 없음"}
                  </div>
                </div>
                <button className="btn shrink-0 px-2 py-1 text-xs" disabled={busy !== null} onClick={() => restore(m)}>
                  {busy === m.id ? "되돌리는 중…" : "되돌리기"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
