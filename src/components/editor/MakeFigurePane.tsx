"use client";

import { useEditorState, type Editor } from "@tiptap/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, fmtTime } from "@/lib/client";
import { FIGURE_ASPECTS, FIGURE_STYLES, buildFigurePrompt, figureFallbackSize, figureRequestSize, type FigureAspect, type FigureStyle } from "@/lib/images/figure-prompt";
import { confirmDialog, toast, toastError } from "../ui/feedback";

/** 그림을 넣을 문단 — 번호(1부터, 서버 textblocks 순서)와 문단 앞부분(옮겨졌으면 이것으로 다시 찾는다) */
export type FigureTarget = { paragraph: number; anchor: string };
/** 서버 lib/images/figure-store.ts 의 [만든 그림] */
export type MadeFigure = { assetId: string; src: string; widthPx: number; heightPx: number; prompt: string; paragraph: string; at: string; edit?: boolean };

export const ANCHOR_LEN = 40;

/** 커서가 있는 문단 (소제목·그림 선택이면 없음) */
function cursorParagraph(e: Editor): (FigureTarget & { text: string }) | null {
  const { $from } = e.state.selection;
  let d = $from.depth;
  while (d > 0 && $from.node(d).type.name !== "paragraph") d--;
  if (d === 0) return null;
  const node = $from.node(d);
  const pos = $from.before(d);
  let i = 0;
  let index = 0;
  e.state.doc.descendants((n, p) => {
    if (index) return false;
    if (n.type.name === "paragraph" || n.type.name === "heading") {
      i++;
      if (p === pos) index = i;
      return false;
    }
    return true;
  });
  const text = node.textContent.trim();
  return index && text ? { paragraph: index, anchor: text.slice(0, ANCHOR_LEN), text } : null;
}

/*
 * 설정·진행 상태·만든 그림은 이 탭 밖(모듈)에 둔다 — 다른 탭이나 방식으로 옮겨 갔다 와도 그리던 그림과 값이 그대로 남는다.
 */
type Opts = { style: FigureStyle; aspect: FigureAspect; requestSize: string; instruction: string; withText: boolean };
type Run = { kind: "make" | "edit"; startedAt: number; abort: AbortController; editOf?: string };
type Sec = { history: MadeFigure[] | null; run: Run | null; captions: Record<string, string>; editOpen: string | null; editPrompt: string };
let opts: Opts = { style: "diagram", aspect: "landscape", requestSize: "auto", instruction: "", withText: false };
const secs = new Map<string, Sec>();
const subs = new Set<() => void>();
const bump = () => subs.forEach((l) => l());
let version = 0;
const EMPTY: Sec = { history: null, run: null, captions: {}, editOpen: null, editPrompt: "" };
const getSec = (sid: string) => secs.get(sid) ?? EMPTY;
const patchSec = (sid: string, p: Partial<Sec>) => {
  secs.set(sid, { ...getSec(sid), ...p });
  version++;
  bump();
};
const setOpts = (p: Partial<Opts>) => {
  opts = { ...opts, ...p };
  version++;
  bump();
};
function useStore() {
  return useSyncExternalStore(
    (l) => (subs.add(l), () => subs.delete(l)),
    () => version,
    () => 0,
  );
}

async function loadHistory(sid: string) {
  try {
    const r = await api<{ history: MadeFigure[] }>(`/api/sections/${sid}/images/generate`);
    patchSec(sid, { history: r.history });
  } catch (e) {
    patchSec(sid, { history: [] });
    toastError(e, "만든 그림을 불러오지 못했습니다: ");
  }
}

async function make(sid: string, body: Record<string, unknown>, kind: Run["kind"], editOf?: string) {
  const abort = new AbortController();
  patchSec(sid, { run: { kind, startedAt: Date.now(), abort, editOf } });
  try {
    const r = await api<{ item: MadeFigure; history: MadeFigure[] }>(`/api/sections/${sid}/images/generate`, { method: "POST", json: body, signal: abort.signal, timeoutMs: 290_000 });
    patchSec(sid, { history: r.history, ...(kind === "edit" ? { editOpen: null, editPrompt: "" } : {}) });
    toast.success(kind === "edit" ? "그림을 고쳤습니다. 아래 [만든 그림] 맨 위에 있습니다." : "그림을 만들었습니다. 캡션을 적고 [승인]하면 문단 끝에 들어갑니다.");
  } catch (e) {
    if (!abort.signal.aborted) toastError(e, kind === "edit" ? "그림을 고치지 못했습니다: " : "그림을 만들지 못했습니다: ");
  } finally {
    patchSec(sid, { run: null });
  }
}

type Props = {
  sectionId: string;
  editor: Editor;
  bookTitle: string;
  sectionTitle: string;
  lockReason: string;
  onInsert: (target: FigureTarget, f: MadeFigure, caption: string) => boolean;
  onLocate: (t: FigureTarget) => void;
};

/**
 * [이미지] 탭 → 직접 만들기 — 표지 디자인 AI와 같은 그림 연결(Images API)로, 본문에서 고른 문단을 그림으로 그린다.
 * 프롬프트 안·요청 크기·추가 지시·글자 넣기 선택, 만든 그림 수정(다시 만들지 않고 고칠 것만)·삭제까지 표지 편집기와 같다.
 */
export default function MakeFigurePane({ sectionId, editor, bookTitle, sectionTitle, lockReason, onInsert, onLocate }: Props) {
  useStore();
  const sec = getSec(sectionId);
  const target = useEditorState({ editor, selector: ({ editor: e }) => cursorParagraph(e) });
  const [now, setNow] = useState(Date.now());
  const run = sec.run;
  useEffect(() => {
    if (!run) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [run]);
  useEffect(() => {
    if (getSec(sectionId).history === null) void loadHistory(sectionId);
  }, [sectionId]);

  const size = figureRequestSize(opts.aspect, opts.requestSize);
  const autoPrompt = buildFigurePrompt({ bookTitle, sectionTitle, paragraph: target?.text ?? "(본문에서 그림을 넣을 문단을 클릭하세요)", style: opts.style, instruction: opts.instruction, withText: opts.withText });
  // 직접 고친 프롬프트 — 고친 그 문단에서만 쓴다(다른 문단을 누르면 자동 프롬프트로)
  const [own, setOwn] = useState<{ anchor: string; text: string } | null>(null);
  const ownText = own && target && own.anchor === target.text ? own.text : null;
  const prompt = ownText ?? autoPrompt;
  const elapsed = run ? Math.max(0, Math.round((now - run.startedAt) / 1000)) : 0;
  const body = { style: opts.style, aspect: opts.aspect, requestSize: opts.requestSize, instruction: opts.instruction, withText: opts.withText };

  const runMake = () => {
    if (!target) return toast("본문에서 그림을 넣을 문단을 먼저 클릭하세요.");
    void make(sectionId, { ...body, paragraph: target.text, ...(ownText ? { customPrompt: ownText } : {}) }, "make");
  };
  const runEdit = (f: MadeFigure) => {
    if (!sec.editPrompt.trim()) return;
    void make(sectionId, { ...body, paragraph: f.paragraph, editOf: f.assetId, editPrompt: sec.editPrompt }, "edit", f.assetId);
  };
  const remove = async (f: MadeFigure) => {
    if (!(await confirmDialog("이 그림을 [만든 그림]에서 지울까요? 본문에 이미 넣었으면 본문의 그림은 그대로 둡니다.", { okLabel: "지우기" }))) return;
    try {
      const r = await api<{ history: MadeFigure[]; kept: boolean }>(`/api/sections/${sectionId}/images/generate?assetId=${f.assetId}`, { method: "DELETE" });
      patchSec(sectionId, { history: r.history });
      toast.success(r.kept ? "목록에서 뺐습니다(본문에 넣은 그림은 남겨 두었습니다)." : "그림을 지웠습니다.");
    } catch (e) {
      toastError(e, "지우지 못했습니다: ");
    }
  };
  const targetOf = (f: MadeFigure): FigureTarget => ({ paragraph: 0, anchor: f.paragraph.slice(0, ANCHOR_LEN) });

  return (
    <div className="h-full space-y-3 overflow-auto p-3 text-sm">
      <p className="text-xs leading-5 text-stone-600">
        고른 문단의 내용을 AI가 그림(도식·삽화 등)으로 그립니다. [승인]하면 그 문단 끝에 들어갑니다.
      </p>

      <div>
        <label className="label">그림을 넣을 문단</label>
        {target ? (
          <div className="rounded border border-indigo-200 bg-indigo-50/60 p-2 text-[11px] leading-4 text-indigo-950">
            <button className="mb-1 rounded bg-indigo-100 px-1.5 py-0.5 font-semibold text-indigo-800 hover:bg-indigo-200" onClick={() => onLocate(target)} title="본문에서 이 문단 보기">
              문단 {target.paragraph} ↗
            </button>
            <p className="line-clamp-3">“{target.text}”</p>
          </div>
        ) : (
          <p className="rounded border border-dashed border-stone-300 p-2 text-[11px] text-stone-500">본문에서 그림을 넣을 문단을 클릭하세요. 커서가 있는 문단을 그립니다.</p>
        )}
      </div>

      <div>
        <label className="label">그림 종류</label>
        <div className="grid grid-cols-2 gap-1">
          {FIGURE_STYLES.map((s) => (
            <button key={s.v} className={`rounded border px-2 py-1 text-xs ${opts.style === s.v ? "border-indigo-500 bg-indigo-50 font-semibold text-indigo-900" : "border-stone-200 bg-white text-stone-600 hover:bg-stone-50"}`} onClick={() => setOpts({ style: s.v })}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="label">비율 · 요청 크기</label>
        <div className="flex items-center gap-1">
          {FIGURE_ASPECTS.map((a) => (
            <button key={a.v} className={`rounded border px-2 py-1 text-xs ${opts.aspect === a.v ? "border-indigo-500 bg-indigo-50 font-semibold text-indigo-900" : "border-stone-200 bg-white text-stone-600"}`} onClick={() => setOpts({ aspect: a.v })}>
              {a.label}
            </button>
          ))}
          <input className="input ml-1 py-0.5 font-mono text-[11px]" style={{ width: 84 }} value={opts.requestSize} onChange={(e) => setOpts({ requestSize: e.target.value.trim() || "auto" })} title="auto 또는 가로x세로 (예: 1536x1024)" />
        </div>
        <p className="mt-1 font-mono text-[11px] text-stone-500">→ {size} · 거부되면 {figureFallbackSize(opts.aspect)}</p>
      </div>

      <div>
        <label className="label">추가 지시</label>
        <textarea className="input h-16 text-xs leading-5" placeholder={"예: 파란색 계열 두 가지만, 단계마다 번호 원.\n사람은 넣지 말고 사물로만."} value={opts.instruction} onChange={(e) => setOpts({ instruction: e.target.value })} />
      </div>
      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" className="mt-0.5" checked={opts.withText} onChange={(e) => setOpts({ withText: e.target.checked })} />
        <span>
          그림에 짧은 한글 라벨 넣기 <span className="text-stone-500">(끄면 글자 없이 그립니다 — AI가 한글을 틀리게 쓸 수 있어 기본은 끔. 설명은 캡션으로)</span>
        </span>
      </label>

      <details className="rounded border border-stone-200 bg-white">
        <summary className="cursor-pointer px-2 py-1 text-xs font-semibold text-stone-600">
          프롬프트 안 (요청 {size}){ownText ? <span className="ml-1 font-normal text-amber-700">· 직접 고침</span> : null}
        </summary>
        <textarea
          className={`block h-56 w-full resize-y border-0 border-t border-stone-100 p-2 font-mono text-[11px] leading-4 outline-none ${ownText ? "bg-amber-50/40 text-stone-800" : "bg-stone-50 text-stone-600"}`}
          spellCheck={false}
          value={prompt}
          disabled={!target}
          aria-label="프롬프트 안 (직접 고칠 수 있음)"
          onChange={(e) => target && setOwn(e.target.value.trim() && e.target.value !== autoPrompt ? { anchor: target.text, text: e.target.value } : null)}
        />
        <div className="flex items-center justify-between gap-2 border-t border-stone-100 px-2 py-1 text-[11px] text-stone-500">
          <span>{ownText ? "고친 프롬프트를 그대로 보냅니다(이 문단에서만)." : "여기서 바로 고쳐 쓸 수 있습니다."}</span>
          {ownText && (
            <button className="btn-ghost px-1.5 py-0.5 text-[11px]" onClick={() => setOwn(null)}>
              자동으로 되돌리기
            </button>
          )}
        </div>
      </details>

      {run?.kind === "make" ? (
        <button className="btn-primary w-full bg-red-700 hover:bg-red-800" onClick={() => run.abort.abort()}>
          ■ 그리는 중… {elapsed}초 (1~3분) — 멈추기
        </button>
      ) : (
        <button className="btn-image w-full px-3.5 py-2 text-sm" disabled={!!run || !target} onClick={runMake} title={target ? undefined : "본문에서 문단을 먼저 클릭하세요"}>
          {target ? `✨ AI 제작 — 문단 ${target.paragraph}` : "✨ AI 제작 (본문에서 문단을 클릭)"}
        </button>
      )}

      <div>
        <div className="label">만든 그림 {sec.history?.length ? `(${sec.history.length})` : ""}</div>
        {sec.history === null ? (
          <p className="text-xs text-stone-400">불러오는 중…</p>
        ) : sec.history.length === 0 ? (
          <p className="text-xs text-stone-400">아직 만든 그림이 없습니다.</p>
        ) : (
          <ul className="space-y-2">
            {sec.history.map((f) => {
              const editing = sec.editOpen === f.assetId;
              const caption = sec.captions[f.assetId] ?? "";
              return (
                <li key={f.assetId} className="rounded-lg border border-indigo-200 bg-white p-2 shadow-sm">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={f.src} alt="만든 그림" className="mb-1.5 max-h-48 w-full rounded border border-stone-100 object-contain" />
                  <div className="mb-1 flex items-center gap-1 text-[10px] text-stone-400">
                    <span>
                      {fmtTime(f.at)} · {f.widthPx}×{f.heightPx}px{f.edit ? " · 수정본" : ""}
                    </span>
                    <button className="ml-auto underline hover:text-indigo-700" onClick={() => onLocate(targetOf(f))}>
                      문단 보기
                    </button>
                  </div>
                  <p className="mb-1 line-clamp-1 text-[11px] text-stone-500" title={f.paragraph}>
                    “{f.paragraph}…”
                  </p>
                  <input className="input py-1 text-xs" placeholder="캡션 (그림 번호는 자동)" value={caption} maxLength={160} onChange={(e) => patchSec(sectionId, { captions: { ...sec.captions, [f.assetId]: e.target.value } })} />
                  <div className="mt-1.5 flex gap-1">
                    <button
                      className="btn-image flex-1 px-2 py-1 text-xs"
                      disabled={!!lockReason}
                      title={lockReason || "이 그림을 만든 문단 끝에 캡션과 함께 넣습니다"}
                      onClick={() => {
                        if (onInsert(targetOf(f), f, caption.trim())) toast.success("문단 끝에 그림을 넣었습니다.");
                      }}
                    >
                      승인 — 문단 끝에 넣기
                    </button>
                    <button className="btn px-2 py-1 text-xs" disabled={!!run} onClick={() => patchSec(sectionId, { editOpen: editing ? null : f.assetId, editPrompt: "" })}>
                      수정
                    </button>
                    <button className="btn px-2 py-1 text-xs text-red-700" disabled={run?.editOf === f.assetId} onClick={() => void remove(f)}>
                      삭제
                    </button>
                  </div>
                  {editing && (
                    <div className="mt-2 space-y-1.5 rounded border border-violet-200 bg-violet-50/40 p-2">
                      <label className="label mb-0 text-[11px]">이 그림 수정 — 다시 만들지 않고 고칠 것만 요청</label>
                      <textarea className="input h-16 text-xs leading-5" placeholder="예: 화살표를 더 굵게, 배경의 회색 음영은 빼 줘." value={sec.editPrompt} onChange={(e) => patchSec(sectionId, { editPrompt: e.target.value })} disabled={!!run} />
                      {run?.kind === "edit" && run.editOf === f.assetId ? (
                        <button className="btn-primary w-full bg-red-700 py-1 text-xs hover:bg-red-800" onClick={() => run.abort.abort()}>
                          ■ 고치는 중… {elapsed}초 — 멈추기
                        </button>
                      ) : (
                        <button className="btn w-full border-violet-300 py-1 text-xs text-violet-900" disabled={!!run || !sec.editPrompt.trim()} onClick={() => runEdit(f)}>
                          수정 요청
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
