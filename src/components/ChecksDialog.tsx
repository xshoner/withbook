"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { StyleReport } from "@/lib/style/check";
import { toastError } from "@/components/ui/feedback";

type Marker = {
  paragraph: number;
  offset: number;
  footnote?: number;
  marker: string;
  kind: "check" | "image";
  before: string;
  after: string;
};
type Result = {
  total: number;
  sections: {
    sectionId: string;
    label: string;
    title: string;
    chapterTitle: string;
    markers: Marker[];
  }[];
};

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
  const [tab, setTab] = useState<"marks" | "style">("marks");
  const [styleSeen, setStyleSeen] = useState(false);

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
      await api(`/api/projects/${projectId}/checks`, {
        method: "POST",
        json: {
          sectionId,
          ...m,
          action,
          note: action === "footnote" ? note : undefined,
        },
      });
      setOpen(null);
      setNote("");
      onEdited([sectionId]);
      await load();
    } catch (e) {
      toastError(e);
      await load();
    } finally {
      setBusy(null);
    }
  };

  const shown = res?.sections
    .map((s) => ({
      ...s,
      markers: s.markers.filter((m) => kind === "all" || m.kind === kind),
    }))
    .filter((s) => s.markers.length);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-2xl">
        <div className="flex items-center gap-3 border-b border-stone-200 px-4 py-3">
          <div className="flex overflow-hidden rounded-md border border-stone-300 text-sm">
            <button className={`px-2.5 py-1 font-semibold ${tab === "marks" ? "bg-stone-800 text-white" : "text-stone-600"}`} onClick={() => setTab("marks")}>
              표시 확인 {res ? `(${res.total})` : ""}
            </button>
            <button
              className={`px-2.5 py-1 font-semibold ${tab === "style" ? "bg-stone-800 text-white" : "text-stone-600"}`}
              onClick={() => {
                setTab("style");
                setStyleSeen(true);
              }}
            >
              문체 점검
            </button>
          </div>
          {tab === "marks" && (
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
          )}
          {tab === "marks" && (
            <button className="btn-ghost ml-auto text-xs" onClick={load}>
              ↻ 새로 고침
            </button>
          )}
          <button className={`btn-ghost ${tab === "style" ? "ml-auto" : ""}`} onClick={onClose}>
            ✕
          </button>
        </div>
        {/* 문체 점검은 처음 열 때 불러오고, 탭을 오가도 결과를 유지한다 */}
        {styleSeen && (
          <div className={tab === "style" ? "contents" : "hidden"}>
            <StyleTab projectId={projectId} beforeEdit={beforeEdit} onGoto={onGoto} />
          </div>
        )}
        {tab === "marks" && (
          <>
            <p className="border-b border-stone-100 px-4 py-2 text-[11px] leading-4 text-stone-500">
              AI가 확신 없는 수치·사실 뒤에 남긴 표시입니다. 사실을 확인했으면 [확인함], 근거를 책에 남기려면 [출처를 각주로]를 누르세요. 처리 전 원고는 버전 기록에 남습니다. 인쇄 전에 모두
              처리하세요.
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
                              <button
                                className="rounded bg-stone-800 px-2 py-0.5 font-semibold text-white hover:bg-stone-700"
                                title={`${s.label} ${s.title}의 이 문장으로 바로 갑니다`}
                                // 표시 바로 앞 글자까지 넘겨 같은 문단에 표시가 여러 개여도 정확한 문장으로 간다 (각주 안 표시는 문단으로)
                                onClick={() => onGoto(s.sectionId, m.paragraph, m.offset >= 0 ? m.before.slice(-15) + m.marker : "")}
                              >
                                바로가기 →
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
          </>
        )}
      </div>
    </div>
  );
}

const STYLE_NAME: Record<string, string> = {
  da: "‘-다’체 (평서)",
  yo: "‘-요’체 (해요)",
  sumnida: "‘-니다’체 (합쇼)",
  other: "기타",
};
const STYLE_SHORT: Record<string, string> = {
  da: "-다",
  yo: "-요",
  sumnida: "-니다",
  other: "기타",
};

function Go({
  onGoto,
  sid,
  p,
  t,
  where,
  children,
}: {
  onGoto: (sectionId: string, paragraph: number, text: string) => void;
  sid: string;
  p: number;
  t: string;
  where: string;
  children?: React.ReactNode;
}) {
  return (
    <button className="shrink-0 rounded bg-stone-800 px-1.5 py-0.5 text-[11px] font-semibold text-white hover:bg-stone-700" title={`${where} — 이 문장으로 바로 갑니다`} onClick={() => onGoto(sid, p, t)}>
      {children ?? "바로가기 →"}
    </button>
  );
}

const H = ({ children }: { children: React.ReactNode }) => <h3 className="mb-1.5 mt-5 text-xs font-semibold text-stone-700 first:mt-0">{children}</h3>;

/** 문체 점검 탭 — 규칙 기반, 처음 열 때 한 번 불러온다 */
function StyleTab({ projectId, beforeEdit, onGoto }: { projectId: string; beforeEdit: () => Promise<boolean>; onGoto: (sectionId: string, paragraph: number, text: string) => void }) {
  const [r, setR] = useState<StyleReport | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setErr("");
    setBusy(true);
    try {
      if (!(await beforeEdit())) throw new Error("저장을 완료하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
      setR(await api<StyleReport>(`/api/projects/${projectId}/style-check`));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const where = (sid: string, p: number) => {
    const s = r?.sections.find((x) => x.sectionId === sid);
    return `${s ? `${s.label} ${s.title}`.trim() : ""} · ${p}문단`;
  };
  const go = (sid: string, p: number, t: string, children?: React.ReactNode, key?: number) => (
    <Go key={key} onGoto={onGoto} sid={sid} p={p} t={t} where={where(sid, p)}>
      {children}
    </Go>
  );

  return (
    <>
      <div className="flex items-center gap-2 border-b border-stone-100 px-4 py-2 text-[11px] leading-4 text-stone-500">
        <span className="flex-1">규칙으로 찾은 참고용 결과입니다. 따옴표 안 대화는 어미 점검에서 뺍니다. 고칠지는 작가가 판단하세요.</span>
        <button className="btn-ghost shrink-0 text-xs" disabled={busy} onClick={load}>
          {busy ? "점검 중…" : "↻ 다시 점검"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
        {err && <p className="text-red-600">{err}</p>}
        {!r && !err && <p className="text-stone-400">점검 중…</p>}
        {r && (
          <>
            <H>종결어미</H>
            {r.endings.dominant ? (
              <div className="text-xs leading-5 text-stone-600">
                이 책의 기본 문체: <b className="text-stone-800">{STYLE_NAME[r.endings.dominant]}</b>
                <span className="ml-2 text-stone-400">{(["da", "yo", "sumnida", "other"] as const).map((k) => `${STYLE_SHORT[k]} ${r.endings.total[k].toLocaleString()}`).join(" · ")}</span>
                <div className={r.endings.mismatchTotal ? "text-amber-700" : "text-green-700"}>
                  {r.endings.mismatchTotal
                    ? `기본 문체와 다른 문장 ${r.endings.mismatchTotal.toLocaleString()}개${r.endings.mismatchTotal > 200 ? " (앞 200개만 표시)" : ""}`
                    : "서술 문장이 모두 같은 어미 체계입니다."}
                </div>
              </div>
            ) : (
              <p className="text-xs text-stone-400">판단할 서술 문장이 없습니다.</p>
            )}
            {r.endings.mismatches.length > 0 && (
              <div className="mt-2 space-y-2">
                {r.endings.mismatches.map((g) => {
                  const c = r.sections.find((s) => s.sectionId === g.sectionId)?.counts;
                  return (
                    <div key={g.sectionId} className="rounded-lg border border-stone-200">
                      <div className="flex items-baseline gap-2 border-b border-stone-100 bg-stone-50 px-3 py-1 text-xs font-semibold text-stone-700">
                        {g.label} {g.title}
                        {c && (
                          <span className="font-normal text-stone-400">
                            -다 {c.da} · -요 {c.yo} · -니다 {c.sumnida}
                          </span>
                        )}
                      </div>
                      <ul className="divide-y divide-stone-100">
                        {g.items.map((it, i) => (
                          <li key={i} className="flex items-start gap-2 px-3 py-1.5 text-xs leading-5">
                            <span className="mt-0.5 shrink-0 rounded bg-amber-100 px-1 text-[10px] text-amber-800">{STYLE_SHORT[it.style]}</span>
                            <span className="flex-1 font-book text-stone-700">{it.sentence}</span>
                            <span className="shrink-0 text-[11px]">{go(g.sectionId, it.paragraph, it.text)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}

            <H>자주 쓴 표현</H>
            {r.repeats.length ? (
              <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200">
                {r.repeats.map((g) => (
                  <li key={g.gram} className="flex flex-wrap items-baseline gap-x-2 px-3 py-1 text-xs leading-5">
                    <span className="font-book text-stone-800">{g.gram}</span>
                    <span className="text-stone-400">{g.count}회</span>
                    <span className="ml-auto flex gap-2 text-[11px]">{g.locations.map((l, i) => go(l.sectionId, l.paragraph, l.text, `위치${i + 1}`, i))}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-stone-400">세 번 이상 되풀이한 표현이 없습니다.</p>
            )}

            <H>
              접속부사{" "}
              {r.sentenceTotal ? (
                <span className="font-normal text-stone-400">
                  (횟수 · 1,000문장당, 전체 {r.sentenceTotal.toLocaleString()}
                  문장)
                </span>
              ) : null}
            </H>
            {r.connectives.length ? (
              <ul className="flex flex-wrap gap-1.5 text-xs">
                {r.connectives.map((c) => (
                  <li key={c.word} className={`flex items-center gap-1 rounded-md border px-2 py-0.5 ${c.flagged ? "border-amber-300 bg-amber-50 text-amber-800" : "border-stone-200 text-stone-600"}`}>
                    {c.flagged && <span title="많이 씀">⚠</span>}
                    {c.word}
                    <span className="text-stone-400">
                      {c.count}회 · {c.perThousand}
                    </span>
                    {c.locations.slice(0, 3).map((l, i) => go(l.sectionId, l.paragraph, l.text, <span className="text-[10px]">↗{i + 1}</span>, i))}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-stone-400">쓴 접속부사가 없습니다.</p>
            )}

            <H>한 문단 안에서 되풀이한 단어</H>
            {r.inParagraph.length ? (
              <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200">
                {r.inParagraph.map((w, i) => (
                  <li key={i} className="flex items-baseline gap-2 px-3 py-1 text-xs leading-5">
                    <span className="font-book text-stone-800">{w.word}</span>
                    <span className="shrink-0 text-stone-400">{w.count}회</span>
                    <span className="truncate text-stone-400">
                      {w.label} {w.title} · {w.paragraph}문단
                    </span>
                    <span className="ml-auto shrink-0 text-[11px]">{go(w.sectionId, w.paragraph, w.text)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-stone-400">한 문단에서 세 번 이상 되풀이한 단어가 없습니다.</p>
            )}
          </>
        )}
      </div>
    </>
  );
}
