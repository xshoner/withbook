"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { BATCH_MAX } from "./batch";
import { confirmDialog } from "../ui/feedback";

export type SectionRef = { id: string; title: string; label: string; chapterTitle: string; targetPages: number; charCount: number; gist: string };
export type BatchItem = { id: string; title: string; label: string; targetPages: number; sketch: string };

export { BATCH_MAX };

/**
 * 여러 절 한 번에 집필 — 최대 3개 절을 골라 절마다 분량·스케치를 정한다.
 * 책 순서대로 하나씩 쓰므로 앞 절 내용이 다음 절에 이어진다.
 */
export default function BatchWriteDialog(props: {
  sections: SectionRef[];
  currentId: string;
  /** AI 집필·교정 중인 절 — 고를 수 없다 */
  busyIds?: ReadonlySet<string>;
  currentSketch: string;
  currentPages: number;
  cpp: number;
  /** 처음 채울 추가 지시 (지금 입력칸 → 계속 쓰기로 둔 것 → 최근 것 순) */
  initialExtra: string;
  recentExtra: string[];
  onClose: () => void;
  onStart: (items: BatchItem[], extraInstruction: string) => void;
}) {
  const { sections, currentId } = props;
  const busy = (id: string) => !!props.busyIds?.has(id);
  const [picked, setPicked] = useState<string[]>(busy(currentId) ? [] : [currentId]);
  const [pages, setPages] = useState<Record<string, number>>({ [currentId]: props.currentPages });
  const [sketch, setSketch] = useState<Record<string, string>>({ [currentId]: props.currentSketch });
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [extra, setExtra] = useState(props.initialExtra);

  const order = useMemo(() => new Map(sections.map((s, i) => [s.id, i])), [sections]);
  const startIdx = order.get(currentId) ?? 0;
  // 지금 절 앞 1개부터 뒤로 목록을 보여 준다
  const list = sections.slice(Math.max(0, startIdx - 1));

  const toggle = async (s: SectionRef) => {
    if (picked.includes(s.id)) return setPicked(picked.filter((x) => x !== s.id));
    if (picked.length >= BATCH_MAX || busy(s.id)) return;
    setPicked([...picked, s.id]);
    setPages((p) => ({ ...p, [s.id]: p[s.id] ?? (s.targetPages || 3) }));
    if (sketch[s.id] === undefined) {
      setLoading((l) => ({ ...l, [s.id]: true }));
      try {
        const r = await api<{ sketch: string }>(`/api/sections/${s.id}`);
        setSketch((k) => ({ ...k, [s.id]: r.sketch ?? "" }));
      } catch {
        setSketch((k) => ({ ...k, [s.id]: "" }));
      } finally {
        setLoading((l) => ({ ...l, [s.id]: false }));
      }
    }
  };

  // 창을 연 뒤에 작업이 시작된 절은 뺀다
  const chosen = sections.filter((s) => picked.includes(s.id) && !busy(s.id)); // 책 순서
  const overwrite = chosen.filter((s) => s.charCount > 0);
  const start = async () => {
    if (!chosen.length) return;
    if (overwrite.length && !(await confirmDialog(`이미 본문이 있는 절 ${overwrite.length}개는 지금 본문을 버전 기록에 보관한 뒤 새로 씁니다. 진행할까요?`, { okLabel: "새로 쓰기" }))) return;
    props.onStart(
      chosen.map((s) => ({ id: s.id, title: s.title, label: s.label, targetPages: pages[s.id] ?? (s.targetPages || 3), sketch: sketch[s.id] ?? "" })),
      extra.trim(),
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4" onMouseDown={props.onClose}>
      <div className="flex max-h-[88vh] w-[760px] max-w-full flex-col rounded-xl bg-white shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="border-b border-stone-200 px-5 py-3">
          <h2 className="font-semibold">다중 집필</h2>
          <p className="text-xs text-stone-500">
            최대 {BATCH_MAX}개 절을 고르세요. 책 순서대로 하나씩 쓰고, 앞 절 내용이 다음 절에 자연스럽게 이어집니다. 절마다 분량과 스케치를 따로 정할 수 있습니다.
          </p>
        </div>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-auto px-5 py-3">
          {list.map((s) => {
            const isBusy = busy(s.id);
            const on = picked.includes(s.id) && !isBusy;
            const full = (!on && picked.length >= BATCH_MAX) || isBusy;
            return (
              <div key={s.id} className={`rounded-lg border ${on ? "border-amber-400 bg-amber-50/60" : "border-stone-200"} ${full ? "opacity-50" : ""}`}>
                <label className={`flex items-center gap-2 px-3 py-2 text-sm ${full ? "cursor-not-allowed" : "cursor-pointer"}`}>
                  <input type="checkbox" checked={on} disabled={full} onChange={() => toggle(s)} title={isBusy ? "AI 집필·교정 중인 절은 고를 수 없습니다" : undefined} />
                  <span className="shrink-0 text-xs text-stone-400">{s.label}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{s.title}</span>
                  {s.id === currentId && <span className="rounded bg-stone-800 px-1.5 text-[10px] text-white">지금 절</span>}
                  {isBusy && <span className="rounded bg-sky-100 px-1.5 text-[10px] text-sky-800">작업 중 — 끝난 뒤에 고르세요</span>}
                  {s.charCount > 0 && <span className="rounded bg-stone-100 px-1.5 text-[10px] text-stone-500">본문 {s.charCount.toLocaleString()}자</span>}
                  <span className="shrink-0 text-[11px] text-stone-400">{s.chapterTitle}</span>
                </label>
                {on && (
                  <div className="space-y-2 border-t border-amber-200 px-3 pb-3 pt-2">
                    <div className="flex items-center gap-2 text-xs text-stone-600">
                      분량
                      <input
                        type="number"
                        min={0.5}
                        max={60}
                        step={0.5}
                        className="w-16 rounded border border-stone-300 px-1.5 py-0.5 text-right text-sm"
                        value={pages[s.id] ?? 3}
                        onChange={(e) => setPages({ ...pages, [s.id]: Math.max(0.5, Math.min(60, Number(e.target.value) || 1)) })}
                      />
                      페이지 <span className="text-stone-400">(약 {Math.round((pages[s.id] ?? 3) * props.cpp).toLocaleString()}자)</span>
                      {s.gist && <span className="ml-2 min-w-0 flex-1 truncate text-stone-400" title={s.gist}>요지: {s.gist}</span>}
                    </div>
                    <textarea
                      className="input min-h-[72px] text-xs leading-5"
                      placeholder={loading[s.id] ? "스케치 불러오는 중…" : "이 절의 스케치 (비우면 목차 요지로 씁니다)"}
                      value={sketch[s.id] ?? ""}
                      disabled={loading[s.id]}
                      onChange={(e) => setSketch({ ...sketch, [s.id]: e.target.value })}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="border-t border-stone-200 px-5 py-3">
          <label className="mb-1 block text-xs font-semibold text-stone-600" htmlFor="batch-extra">
            집필 추가 지시 <span className="font-normal text-stone-400">— 고른 절 모두에 적용</span>
          </label>
          <textarea
            id="batch-extra"
            className="input min-h-[52px] text-xs"
            placeholder="예: 사례는 교육 현장 위주로, 마지막은 질문으로 끝내기 (비우면 추가 지시 없이)"
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
          />
          {props.recentExtra.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {props.recentExtra.map((r) => (
                <button
                  key={r}
                  title={r}
                  onClick={() => setExtra(r)}
                  className={`max-w-[240px] truncate rounded-full border px-2 py-0.5 text-[11px] ${r === extra.trim() ? "border-amber-500 bg-amber-50 text-amber-900" : "border-stone-300 text-stone-600 hover:bg-stone-50"}`}
                >
                  {r}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-stone-200 px-5 py-3">
          <span className="text-xs text-stone-500">
            {chosen.length}/{BATCH_MAX}개 선택 · 순서: {chosen.map((s) => s.label || s.title).join(" → ") || "없음"}
          </span>
          <button className="btn ml-auto" onClick={props.onClose}>
            취소
          </button>
          <button className="btn-accent" disabled={!chosen.length} onClick={start}>
            ✎ {chosen.length}개 절 집필 시작
          </button>
        </div>
      </div>
    </div>
  );
}
