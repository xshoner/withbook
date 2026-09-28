"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { MEMORY_KINDS, type MemoryItem, type MemoryKind } from "@/lib/book-memory";
import { confirmDialog, toast, toastError } from "@/components/ui/feedback";

const KIND_TONE: Record<MemoryKind, string> = {
  definition: "bg-sky-100 text-sky-800",
  claim: "bg-violet-100 text-violet-800",
  case: "bg-emerald-100 text-emerald-800",
  avoid: "bg-red-100 text-red-800",
  keep: "bg-amber-100 text-amber-900",
};

/** 책의 기억을 한곳에서 다시 읽게 — 같은 책의 여러 편집기·교정 내역 창이 추가해도 목록이 맞도록 */
const subs = new Set<() => void>();
export const memoryChanged = () => subs.forEach((f) => f());

/** 다른 화면(교정 내역·선택 말풍선)에서 한 줄로 추가 */
export async function addMemory(projectId: string, kind: MemoryKind, text: string, where?: string) {
  const r = await api<{ duplicate?: boolean }>(`/api/projects/${projectId}/memory`, { method: "POST", json: { kind, text, where } });
  memoryChanged();
  return r;
}

/**
 * [책 기억] 탭 — 작가가 확정한 정의·핵심 주장·쓴 사례·쓰지 않을 것·표현 유지.
 * AI 집필·장 퇴고·교정·부분 수정·일관성 검사가 매번 이 목록을 짧게 참고한다(책 전체에 한 목록).
 */
export default function MemoryPanel({ projectId, where, draft, onDraftUsed }: { projectId: string; where: string; draft?: string | null; onDraftUsed?: () => void }) {
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [err, setErr] = useState("");
  const [kind, setKind] = useState<MemoryKind>("definition");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [filter, setFilter] = useState<MemoryKind | "all">("all");

  const load = () =>
    api<{ items: MemoryItem[] }>(`/api/projects/${projectId}/memory`)
      .then((r) => {
        setItems(r.items);
        setErr("");
      })
      .catch((e) => setErr(e?.message ?? String(e)));
  useEffect(() => {
    void load();
    subs.add(load);
    return () => void subs.delete(load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  useEffect(() => {
    if (!draft) return;
    setText(draft.slice(0, 400));
    onDraftUsed?.();
  }, [draft, onDraftUsed]);

  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await api<{ items: MemoryItem[]; duplicate?: boolean }>(`/api/projects/${projectId}/memory`, { method: "POST", json: { kind, text, where } });
      setItems(r.items);
      setText("");
      if (r.duplicate) toast("이미 있는 항목입니다.");
      memoryChanged();
    } catch (e) {
      toastError(e, "추가하지 못했습니다: ");
    } finally {
      setBusy(false);
    }
  };
  const save = async (id: string, patch: { text?: string; kind?: MemoryKind }) => {
    try {
      const r = await api<{ items: MemoryItem[] }>(`/api/projects/${projectId}/memory`, { method: "PATCH", json: { id, ...patch } });
      setItems(r.items);
      setEditing(null);
    } catch (e) {
      toastError(e, "고치지 못했습니다: ");
    }
  };
  const remove = async (it: MemoryItem) => {
    if (!(await confirmDialog(`「${it.text.slice(0, 40)}」을(를) 책의 기억에서 지울까요?`, { okLabel: "지우기" }))) return;
    try {
      const r = await api<{ items: MemoryItem[] }>(`/api/projects/${projectId}/memory?id=${encodeURIComponent(it.id)}`, { method: "DELETE" });
      setItems(r.items);
    } catch (e) {
      toastError(e, "지우지 못했습니다: ");
    }
  };

  const shown = (items ?? []).filter((i) => filter === "all" || i.kind === filter);
  return (
    <div className="flex h-full flex-col text-xs">
      <div className="space-y-1.5 border-b border-stone-200 p-3">
        <p className="leading-5 text-stone-600">
          작가가 <b>확정한 것</b>을 적어 두면 AI 집필·장 퇴고·교정·부분 수정·일관성 검사가 매번 지킵니다. 본문에서 문장을 드래그해 말풍선의 <b>[기억]</b>으로도 넣을 수 있습니다.
        </p>
        <div className="flex flex-wrap gap-1">
          {(Object.keys(MEMORY_KINDS) as MemoryKind[]).map((k) => (
            <button key={k} className={`rounded px-1.5 py-0.5 ${kind === k ? `${KIND_TONE[k]} font-semibold ring-1 ring-current` : "bg-stone-100 text-stone-600"}`} title={MEMORY_KINDS[k].hint} onClick={() => setKind(k)}>
              {MEMORY_KINDS[k].label}
            </button>
          ))}
        </div>
        <textarea
          className="input h-16 text-xs leading-5"
          placeholder={MEMORY_KINDS[kind].hint}
          value={text}
          maxLength={400}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void add();
          }}
        />
        <div className="flex items-center justify-between text-[11px] text-stone-400">
          <span>{where ? `출처: ${where}` : ""}</span>
          <button className="btn-primary px-2 py-1 text-xs" disabled={busy || !text.trim()} onClick={add}>
            {busy ? "추가 중…" : `${MEMORY_KINDS[kind].label} 추가`}
          </button>
        </div>
      </div>
      {err && (
        <p className="border-b border-red-100 bg-red-50 px-3 py-1.5 text-red-700">
          불러오지 못했습니다: {err}{" "}
          <button className="underline" onClick={load}>
            다시
          </button>
        </p>
      )}
      {items && items.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-stone-100 px-3 py-1.5 text-[11px]">
          {(["all", ...Object.keys(MEMORY_KINDS)] as (MemoryKind | "all")[]).map((k) => {
            const n = k === "all" ? items.length : items.filter((i) => i.kind === k).length;
            if (k !== "all" && !n) return null;
            return (
              <button key={k} className={`rounded px-1.5 ${filter === k ? "bg-stone-800 text-white" : "text-stone-500 hover:bg-stone-100"}`} onClick={() => setFilter(k)}>
                {k === "all" ? "전체" : MEMORY_KINDS[k].label} {n}
              </button>
            );
          })}
        </div>
      )}
      <ul className="min-h-0 flex-1 divide-y divide-stone-100 overflow-auto">
        {items === null && !err && <li className="p-4 text-center text-stone-400">불러오는 중…</li>}
        {items?.length === 0 && <li className="p-4 text-center text-stone-400">아직 없습니다. 이 책에서 꼭 지킬 정의·주장부터 적어 보세요.</li>}
        {shown.map((it) => (
          <li key={it.id} className="group px-3 py-2">
            <div className="flex items-start gap-1.5">
              <select
                className={`shrink-0 rounded px-1 py-0.5 text-[10px] ${KIND_TONE[it.kind]}`}
                value={it.kind}
                onChange={(e) => save(it.id, { kind: e.target.value as MemoryKind })}
                aria-label="종류"
              >
                {(Object.keys(MEMORY_KINDS) as MemoryKind[]).map((k) => (
                  <option key={k} value={k}>
                    {MEMORY_KINDS[k].label}
                  </option>
                ))}
              </select>
              {editing?.id === it.id ? (
                <textarea
                  autoFocus
                  className="input h-16 flex-1 text-xs"
                  value={editing.text}
                  maxLength={400}
                  onChange={(e) => setEditing({ id: it.id, text: e.target.value })}
                  onBlur={() => (editing.text.trim() && editing.text !== it.text ? save(it.id, { text: editing.text }) : setEditing(null))}
                  onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
                />
              ) : (
                <button className="min-w-0 flex-1 text-left leading-5 text-stone-800" title="눌러서 고치기" onClick={() => setEditing({ id: it.id, text: it.text })}>
                  {it.text}
                  {it.where && <span className="ml-1 text-[10px] text-stone-400">({it.where})</span>}
                </button>
              )}
              <button className="shrink-0 text-stone-300 opacity-0 hover:text-red-600 group-hover:opacity-100" title="지우기" onClick={() => remove(it)}>
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
