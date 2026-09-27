"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "@/lib/client";
import { toast, toastError } from "../ui/feedback";
import type { Editor } from "@tiptap/react";
import MakeFigurePane, { type FigureTarget, type MadeFigure } from "./MakeFigurePane";

/** 서버 lib/ai/image-suggest.ts 의 결과 모양 */
export type ImageCandidate = {
  id: string;
  title: string;
  thumb: string;
  src: string;
  width: number;
  height: number;
  description: string;
  artist: string;
  license: string;
  licenseUrl: string;
  pageUrl: string;
  caption: string;
  credit: string;
  score: number;
};
export type ImageSuggestion = { paragraph: number; anchor: string; kind: string; need: string; queries: string[]; candidates: ImageCandidate[] };

type ItemState = { pick: number; caption: string; state: "pending" | "inserting" | "inserted" | "skipped" };
type Entry = { status: "idle" | "running" | "done" | "error"; items: ImageSuggestion[]; ui: ItemState[]; error?: string; at?: number };

const KIND: Record<string, string> = { graph: "그래프", diagram: "도식", figure: "논문 도표", table: "표", map: "지도", photo: "사진", illustration: "삽화" };

/*
 * 추천 결과는 절마다 이 탭 밖(모듈)에 둔다 — 다른 탭·다른 절로 옮겨 갔다 와도 결과와 진행 중인 검색이 그대로 남는다.
 */
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const EMPTY: Entry = { status: "idle", items: [], ui: [] };
const emit = () => listeners.forEach((l) => l());
const setEntry = (sid: string, e: Entry) => {
  entries.set(sid, e);
  emit();
};
const patchItem = (sid: string, i: number, p: Partial<ItemState>) => {
  const e = entries.get(sid);
  if (!e) return;
  setEntry(sid, { ...e, ui: e.ui.map((u, j) => (j === i ? { ...u, ...p } : u)) });
};
function useEntry(sid: string) {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => entries.get(sid) ?? EMPTY,
    () => EMPTY,
  );
}

/** 이미지 추천 실행 — 도구줄 [이미지 추천] 버튼과 이 탭의 버튼이 같이 쓴다. 이미 도는 중이면 다시 부르지 않는다 */
export async function runImageSuggest(sectionId: string, content: string) {
  if (entries.get(sectionId)?.status === "running") return;
  setEntry(sectionId, { status: "running", items: [], ui: [] });
  try {
    const r = await api<{ items: ImageSuggestion[]; searched: number }>(`/api/sections/${sectionId}/images`, { method: "POST", json: { content }, timeoutMs: 300_000 });
    setEntry(sectionId, {
      status: "done",
      items: r.items,
      ui: r.items.map((it) => ({ pick: 0, caption: it.candidates[0]?.caption ?? "", state: "pending" })),
      at: Date.now(),
    });
    if (!r.items.length) toast("이 절에는 맞는 이미지를 찾지 못했습니다. 본문이 더 구체적이면(수치·과정·개념) 다시 시도해 보세요.");
  } catch (e: any) {
    setEntry(sectionId, { status: "error", items: [], ui: [], error: e?.message ?? String(e) });
  }
}

export function useImageSuggestBusy(sectionId: string) {
  return useEntry(sectionId).status === "running";
}

/** [이미지] 탭의 방식 — 외부 자료에서 찾아 제안 / 직접 만들기 (도구줄 메뉴에서 고른 값, 이 탭 밖에 둔다) */
export type ImageMode = "search" | "make";
let mode: ImageMode = "search";
const modeListeners = new Set<() => void>();
export function setImageMode(m: ImageMode) {
  mode = m;
  modeListeners.forEach((l) => l());
}
function useImageMode() {
  return useSyncExternalStore(
    (l) => (modeListeners.add(l), () => modeListeners.delete(l)),
    () => mode,
    () => "search" as ImageMode,
  );
}

type SearchProps = {
  sectionId: string;
  lockReason: string;
  getContent: () => string;
  /** 승인 — 해당 문단 끝에 캡션과 함께 넣는다. 넣었으면 true */
  onInsert: (s: ImageSuggestion, c: ImageCandidate, caption: string) => Promise<boolean>;
  onLocate: (s: FigureTarget) => void;
};

type Props = SearchProps & {
  editor: Editor;
  bookTitle: string;
  sectionTitle: string;
  /** [직접 만들기] 승인 — 만든 그림을 그 문단 끝에 넣는다 */
  onInsertMade: (target: FigureTarget, f: MadeFigure, caption: string) => boolean;
};

/**
 * 오른쪽 패널 [이미지] 탭 — 두 가지 방식:
 *  외부 자료에서 찾아 제안: AI가 문단마다 맞는 논문 도표·그래프·도식을 찾아 보여 주고 [승인]하면 캡션(+출처)과 함께 넣는다.
 *  직접 만들기: 표지 디자인 AI와 같은 그림 연결로 고른 문단의 그림을 그린다.
 */
export default function ImagesPanel(props: Props) {
  const m = useImageMode();
  return (
    <div className="flex h-full flex-col">
      <div role="radiogroup" aria-label="이미지 방식" className="grid grid-cols-2 gap-1 border-b border-stone-200 bg-indigo-50/60 p-1.5 text-xs">
        {(
          [
            ["search", "🔍 외부 자료에서 찾아 제안"],
            ["make", "✨ 직접 만들기"],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            role="radio"
            aria-checked={m === k}
            onClick={() => setImageMode(k)}
            className={`rounded-md px-2 py-1.5 ${m === k ? "bg-white font-semibold text-indigo-900 shadow-sm ring-1 ring-indigo-300" : "text-stone-600 hover:bg-white/70"}`}
          >
            {l}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {m === "search" ? (
          <SearchPane sectionId={props.sectionId} lockReason={props.lockReason} getContent={props.getContent} onInsert={props.onInsert} onLocate={props.onLocate} />
        ) : (
          <MakeFigurePane sectionId={props.sectionId} editor={props.editor} bookTitle={props.bookTitle} sectionTitle={props.sectionTitle} lockReason={props.lockReason} onInsert={props.onInsertMade} onLocate={props.onLocate} />
        )}
      </div>
    </div>
  );
}

function SearchPane({ sectionId, lockReason, getContent, onInsert, onLocate }: SearchProps) {
  const entry = useEntry(sectionId);
  const [bulk, setBulk] = useState(false);
  const running = entry.status === "running";
  const pending = entry.ui.filter((u) => u.state === "pending").length;

  const approve = async (i: number) => {
    const s = entry.items[i];
    const u = entries.get(sectionId)?.ui[i];
    if (!s || !u || u.state !== "pending") return false;
    const c = s.candidates[u.pick];
    patchItem(sectionId, i, { state: "inserting" });
    try {
      const ok = await onInsert(s, c, u.caption.trim() || c.caption);
      patchItem(sectionId, i, { state: ok ? "inserted" : "pending" });
      return ok;
    } catch (e) {
      patchItem(sectionId, i, { state: "pending" });
      toastError(e, "이미지를 넣지 못했습니다: ");
      return false;
    }
  };

  const approveAll = async () => {
    setBulk(true);
    let n = 0;
    try {
      for (let i = 0; i < entry.items.length; i++) if (entries.get(sectionId)?.ui[i]?.state === "pending" && (await approve(i))) n++;
    } finally {
      setBulk(false);
    }
    if (n) toast.success(`이미지 ${n}개를 문단 끝에 넣었습니다.`);
  };

  // 절을 바꾸면 모두 넣기 표시를 푼다
  useEffect(() => setBulk(false), [sectionId]);

  return (
    <div className="flex h-full flex-col text-sm">
      <div className="space-y-2 border-b border-stone-200 p-3">
        <p className="text-xs leading-5 text-stone-600">
          AI가 이 절의 문단을 읽고 그림이 필요한 곳마다 <b>논문 도표·그래프·도식</b> 같은 전문 이미지를 찾아 추천합니다. [승인]하면 그 문단 끝에 캡션·출처와 함께 들어갑니다.
        </p>
        <button className="btn-image w-full px-3.5 py-1.5 text-sm" disabled={running || !!lockReason} title={lockReason || undefined} onClick={() => void runImageSuggest(sectionId, getContent())}>
          {running ? "문단을 읽고 이미지를 찾는 중…" : entry.status === "done" ? "↻ 다시 추천 받기" : "✦ 이 절 이미지 추천 받기"}
        </button>
        {running && (
          <div className="flex items-center gap-2 text-[11px] text-indigo-800">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-indigo-700 border-t-transparent" />
            그림이 필요한 문단 고르기 → 이미지 검색 → 후보 고르기 (보통 20초~1분). 다른 탭·절로 옮겨도 계속됩니다.
          </div>
        )}
        {entry.status === "error" && <p className="rounded bg-red-50 px-2 py-1.5 text-xs text-red-700">추천하지 못했습니다: {entry.error}</p>}
        {entry.status === "done" && entry.items.length > 0 && (
          <div className="flex items-center justify-between text-[11px] text-stone-500">
            <span>
              추천 {entry.items.length}곳 · 남은 {pending}곳
            </span>
            {pending > 1 && (
              <button className="btn px-2 py-0.5 text-[11px]" disabled={bulk || !!lockReason} onClick={() => void approveAll()} title="남은 추천을 지금 고른 후보로 모두 넣습니다">
                {bulk ? "넣는 중…" : "남은 추천 모두 승인"}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {entry.status === "idle" && (
          <div className="rounded-lg border border-dashed border-indigo-200 bg-indigo-50/50 p-3 text-xs leading-5 text-indigo-900">
            <div className="mb-1 font-semibold">이렇게 찾습니다</div>
            <ol className="list-decimal pl-4">
              <li>문단마다 수치·과정·개념·장소가 구체적으로 나오는지 보고 그림이 도움이 될 곳을 고릅니다.</li>
              <li>Wikimedia Commons(오픈 액세스 논문 도표·과학 도식·통계 그래프가 자유 이용 허락으로 올라 있는 곳)에서 찾습니다.</li>
              <li>후보 설명을 문단과 맞춰 보고 맞는 것만 관련도 순으로 보여 주고 캡션을 씁니다.</li>
            </ol>
            <p className="mt-1 text-indigo-800/80">캡션 끝에 저작자·라이선스 출처가 자동으로 붙습니다. 넣은 뒤 그림을 눌러 크기·캡션을 고칠 수 있습니다.</p>
          </div>
        )}
        {entry.items.map((s, i) => {
          const u = entry.ui[i];
          if (!u) return null;
          const c = s.candidates[u.pick];
          const done = u.state === "inserted";
          const skipped = u.state === "skipped";
          return (
            <div key={`${s.paragraph}-${i}`} className={`rounded-lg border bg-white p-2.5 shadow-sm ${done ? "border-emerald-300" : skipped ? "border-stone-200 opacity-60" : "border-indigo-200"}`}>
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px]">
                <button className="rounded bg-indigo-100 px-1.5 py-0.5 font-semibold text-indigo-800 hover:bg-indigo-200" onClick={() => onLocate(s)} title="본문에서 이 문단 보기">
                  문단 {s.paragraph} ↗
                </button>
                <span className="rounded bg-stone-100 px-1.5 py-0.5 text-stone-600">{KIND[s.kind] ?? s.kind}</span>
                {done && <span className="ml-auto font-semibold text-emerald-700">✓ 넣음</span>}
                {skipped && <span className="ml-auto text-stone-400">건너뜀</span>}
              </div>
              <p className="mb-1 line-clamp-2 text-[11px] leading-4 text-stone-400" title={s.anchor}>
                “{s.anchor}…”
              </p>
              {s.need && <p className="mb-2 text-xs leading-4 text-stone-700">{s.need}</p>}
              {!done && !skipped && (
                <>
                  <div className="grid grid-cols-3 gap-1.5">
                    {s.candidates.map((x, j) => (
                      <button
                        key={x.id}
                        className={`relative flex aspect-square items-center justify-center overflow-hidden rounded border bg-stone-50 ${j === u.pick ? "border-indigo-600 ring-2 ring-indigo-500" : "border-stone-200 hover:border-indigo-300"}`}
                        onClick={() => patchItem(sectionId, i, { pick: j, caption: x.caption })}
                        title={`${x.title}${x.description ? `\n${x.description}` : ""}\n${x.width}×${x.height}px · ${x.license}`}
                        aria-pressed={j === u.pick}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={x.thumb} alt={x.title} referrerPolicy="no-referrer" className="max-h-full max-w-full object-contain" />
                        {x.score > 0 && <span className="absolute bottom-0.5 right-0.5 rounded bg-black/60 px-1 text-[9px] text-white">{x.score}</span>}
                      </button>
                    ))}
                  </div>
                  {c && (
                    <div className="mt-2 space-y-1">
                      <div className="truncate text-[11px] text-stone-500" title={c.title}>
                        {c.title} · {c.width}×{c.height}px
                        {c.width < 1000 && <span className="ml-1 text-amber-700" title="인쇄 폭(약 110mm)에서 300 DPI가 안 될 수 있습니다">· 해상도 낮음</span>}
                      </div>
                      <label className="block text-[11px] text-stone-500">
                        캡션
                        <input
                          className="input mt-0.5 py-1 text-xs"
                          value={u.caption}
                          onChange={(e) => patchItem(sectionId, i, { caption: e.target.value })}
                          maxLength={160}
                        />
                      </label>
                      <div className="text-[10px] leading-4 text-stone-400">
                        {c.credit} ·{" "}
                        <a className="underline hover:text-indigo-700" href={c.pageUrl} target="_blank" rel="noreferrer noopener">
                          원본·라이선스 보기
                        </a>
                      </div>
                      <div className="flex gap-1.5 pt-1">
                        <button
                          className="btn-image flex-1 px-2 py-1 text-xs"
                          disabled={u.state === "inserting" || !!lockReason}
                          title={lockReason || "이 문단 끝에 캡션과 함께 넣습니다"}
                          onClick={() => void approve(i)}
                        >
                          {u.state === "inserting" ? "넣는 중…" : "승인 — 문단 끝에 넣기"}
                        </button>
                        <button className="btn py-1 text-xs" disabled={u.state === "inserting"} onClick={() => patchItem(sectionId, i, { state: "skipped" })}>
                          건너뛰기
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
              {skipped && (
                <button className="text-[11px] text-indigo-700 underline" onClick={() => patchItem(sectionId, i, { state: "pending" })}>
                  다시 보기
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
