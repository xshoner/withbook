"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { StyleReport } from "@/lib/style/check";
import { confirmDialog, toastError } from "@/components/ui/feedback";
import InlineDiff from "@/components/InlineDiff";
import { CONSISTENCY_LABEL, type BetaPoint, type BetaResult, type ConsistencyResult } from "@/lib/ai/review-shape";

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

type FactResult = {
  /** unsure: 근거가 없거나 판정이 애매해 원고를 건드리지 않고 표시를 남겼다 */
  verdict: "pass" | "revise" | "unsure";
  issue: string;
  reason: string;
  evidence: { source: string; date: string; url: string }[];
  before: string;
  after: string;
  applied: boolean;
};
type FactRow = { sectionId: string; where: string; paragraph: number; inFootnote: boolean; context: string; result?: FactResult; error?: string };

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
  const [tab, setTab] = useState<"marks" | "style" | "consistency" | "beta">("marks");
  const [styleSeen, setStyleSeen] = useState(false);
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const [aiBusy, setAiBusy] = useState(false);
  const openTab = (t: "consistency" | "beta") => {
    setTab(t);
    setSeen((prev) => new Set(prev).add(t));
  };
  const [judging, setJudging] = useState<{ i: number; total: number } | null>(null);
  const [facts, setFacts] = useState<FactRow[]>([]);
  const stopJudge = useRef(false);

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

  /** 사실 확인 — 표시 확인의 [확인 필요]를 문서 순서대로 하나씩(요청 하나에 하나) 확인한다 */
  const judge = async () => {
    const targets = (res?.sections ?? []).flatMap((s) => s.markers.filter((m) => m.kind === "check").map((m) => ({ s, m })));
    if (!targets.length) return;
    const ok = await confirmDialog(
      `[확인 필요] ${targets.length}건을 사실 확인 AI가 최신 자료로 차례로 확인합니다.\n통과: 표시만 지웁니다 · 보완: 수치·사실관계·근거만 고친 문장으로 바꿉니다.\n바꾸기 전 원고는 버전 기록에 남습니다.`,
      { okLabel: "사실 확인 시작" },
    );
    if (!ok) return;
    if (!(await beforeEdit())) return toastError(new Error("저장을 완료하지 못했습니다. 연결을 확인하고 다시 시도하세요."));
    stopJudge.current = false;
    const rows: FactRow[] = targets.map(({ s, m }) => ({
      sectionId: s.sectionId,
      where: `${s.label} ${s.title}`.trim(),
      paragraph: m.paragraph,
      inFootnote: m.offset < 0,
      context: m.before,
    }));
    setFacts(rows);
    const edited = new Set<string>();
    for (let i = 0; i < targets.length && !stopJudge.current; i++) {
      setJudging({ i, total: targets.length });
      const { s, m } = targets[i];
      try {
        const r = await api<FactResult>(`/api/projects/${projectId}/factcheck`, {
          method: "POST",
          json: { sectionId: s.sectionId, paragraph: m.paragraph, offset: m.offset, footnote: m.footnote, marker: m.marker, before: m.before },
        });
        if (r.applied) edited.add(s.sectionId);
        rows[i] = { ...rows[i], result: r, error: r.applied || r.verdict === "unsure" ? undefined : "원고가 그사이 바뀌어 적용하지 못했습니다." };
      } catch (e) {
        rows[i] = { ...rows[i], error: e instanceof Error ? e.message : String(e) };
      }
      setFacts([...rows]);
    }
    setJudging(null);
    if (edited.size) onEdited([...edited]);
    await load();
  };

  const shown = res?.sections
    .map((s) => ({
      ...s,
      markers: s.markers.filter((m) => kind === "all" || m.kind === kind),
    }))
    .filter((s) => s.markers.length);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-6" onMouseDown={(e) => e.target === e.currentTarget && !judging && !aiBusy && onClose()}>
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
            <button
              className={`px-2.5 py-1 font-semibold ${tab === "consistency" ? "bg-stone-800 text-white" : "text-stone-600"}`}
              title="장 요약과 용어집으로 책 전체에서 어긋나는 사실·되풀이한 사례·지키지 않은 약속·흔들리는 용어를 찾습니다"
              onClick={() => openTab("consistency")}
            >
              책 전체 일관성
            </button>
            <button
              className={`px-2.5 py-1 font-semibold ${tab === "beta" ? "bg-stone-800 text-white" : "text-stone-600"}`}
              title="대상 독자의 눈으로 장을 읽고 늘어지는 곳·이해 안 되는 곳·독자 질문·뺄 곳을 알려 줍니다"
              onClick={() => openTab("beta")}
            >
              베타 리더
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
            <button
              className="ml-auto rounded-md bg-violet-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-violet-600 disabled:opacity-40"
              title="[확인 필요] 표시를 사실 확인 AI가 최신 자료로 모두 차례로 확인합니다 (책 설정 → AI 설정 → 사실 확인)"
              disabled={!!judging || !!busy || !res?.sections.some((s) => s.markers.some((m) => m.kind === "check"))}
              onClick={judge}
            >
              {judging ? `사실 확인 중… ${judging.i + 1}/${judging.total}` : "사실 확인"}
            </button>
          )}
          {tab === "marks" && (
            <button className="btn-ghost text-xs" disabled={!!judging} onClick={load}>
              ↻ 새로 고침
            </button>
          )}
          <button className={`btn-ghost ${tab !== "marks" ? "ml-auto" : ""}`} disabled={!!judging || aiBusy} onClick={onClose}>
            ✕
          </button>
        </div>
        {/* 문체 점검은 처음 열 때 불러오고, 탭을 오가도 결과를 유지한다 */}
        {styleSeen && (
          <div className={tab === "style" ? "contents" : "hidden"}>
            <StyleTab projectId={projectId} beforeEdit={beforeEdit} onGoto={onGoto} />
          </div>
        )}
        {seen.has("consistency") && (
          <div className={tab === "consistency" ? "contents" : "hidden"}>
            <ConsistencyTab projectId={projectId} beforeEdit={beforeEdit} onGoto={onGoto} onBusy={setAiBusy} />
          </div>
        )}
        {seen.has("beta") && (
          <div className={tab === "beta" ? "contents" : "hidden"}>
            <BetaTab projectId={projectId} beforeEdit={beforeEdit} onGoto={onGoto} onBusy={setAiBusy} />
          </div>
        )}
        {tab === "marks" && (
          <>
            <p className="border-b border-stone-100 px-4 py-2 text-[11px] leading-4 text-stone-500">
              AI가 확신 없는 수치·사실 뒤에 남긴 표시입니다. 사실을 확인했으면 [확인함], 근거를 책에 남기려면 [출처를 각주로]를 누르세요. 처리 전 원고는 버전 기록에 남습니다. 인쇄 전에 모두
              처리하세요.
            </p>
            <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
              {facts.length > 0 && <FactPanel rows={facts} judging={judging} onStop={() => (stopJudge.current = true)} onClear={() => setFacts([])} onGoto={onGoto} />}
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

/** 사실 확인 진행과 결과 — 보완은 바뀐 부분을 표시하고 근거를 함께 보여 준다 */
function FactPanel({
  rows,
  judging,
  onStop,
  onClear,
  onGoto,
}: {
  rows: FactRow[];
  judging: { i: number; total: number } | null;
  onStop: () => void;
  onClear: () => void;
  onGoto: (sectionId: string, paragraph: number, text: string) => void;
}) {
  const done = rows.filter((r) => r.result || r.error).length;
  const pass = rows.filter((r) => r.result?.verdict === "pass" && r.result.applied).length;
  const revise = rows.filter((r) => r.result?.verdict === "revise" && r.result.applied).length;
  const unsure = rows.filter((r) => r.result?.verdict === "unsure").length;
  const failed = rows.filter((r) => r.error).length;
  return (
    <div className="mb-4 rounded-lg border border-violet-200 bg-violet-50/40">
      <div className="flex items-center gap-2 border-b border-violet-100 px-3 py-2 text-xs">
        <span className="font-semibold text-violet-900">사실 확인</span>
        <span className="text-stone-600">
          {done}/{rows.length} · <span className="text-green-700">통과 {pass}</span> · <span className="text-amber-700">보완 {revise}</span>
          {unsure > 0 && <span className="text-stone-600"> · 확인 불가 {unsure} (표시 남김)</span>}
          {failed > 0 && <span className="text-red-600"> · 실패 {failed}</span>}
        </span>
        <div className="h-1.5 flex-1 overflow-hidden rounded bg-violet-100">
          <div className="h-full bg-violet-500 transition-all" style={{ width: `${(done / rows.length) * 100}%` }} />
        </div>
        {judging ? (
          <button className="btn-ghost text-xs" onClick={onStop}>
            중지 (지금 항목까지)
          </button>
        ) : (
          <button className="btn-ghost text-xs" onClick={onClear}>
            결과 닫기
          </button>
        )}
      </div>
      <ul className="max-h-[40vh] divide-y divide-violet-100 overflow-auto">
        {rows.map((r, i) => {
          const f = r.result;
          const tag = r.error
            ? ["실패", "bg-red-100 text-red-700"]
            : !f
              ? judging?.i === i
                ? ["확인 중…", "bg-violet-100 text-violet-700"]
                : ["대기", "bg-stone-100 text-stone-500"]
              : f.verdict === "pass"
                ? ["통과", "bg-green-100 text-green-800"]
                : f.verdict === "unsure"
                  ? ["확인 불가", "bg-stone-200 text-stone-700"]
                  : ["보완", "bg-amber-100 text-amber-800"];
          return (
            <li key={i} className="px-3 py-2 text-xs leading-5">
              <div className="flex items-center gap-2">
                <span className={`shrink-0 rounded px-1.5 text-[10px] font-semibold ${tag[1]}`}>{tag[0]}</span>
                {f?.issue && f.verdict === "revise" && <span className="shrink-0 text-[10px] text-amber-700">{f.issue}</span>}
                <span className="truncate text-stone-400">
                  {r.where} · {r.inFootnote ? "각주" : `${r.paragraph}문단`}
                </span>
                {f?.applied && !r.inFootnote && (
                  <button className="ml-auto shrink-0 text-[11px] text-stone-600 hover:underline" onClick={() => onGoto(r.sectionId, r.paragraph, f.after.slice(0, 30))}>
                    바로가기 →
                  </button>
                )}
              </div>
              {f ? (
                <div className="mt-1 font-book text-stone-700">{f.verdict === "revise" ? <InlineDiff before={f.before} after={f.after} /> : f.before}</div>
              ) : (
                <div className="mt-1 truncate text-stone-500">…{r.context}</div>
              )}
              {f?.reason && <div className="mt-0.5 text-[11px] text-stone-500">{f.reason}</div>}
              {f && f.evidence.length > 0 && (
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-stone-400">
                  {f.evidence.map((e, k) => {
                    const label = `${e.source}${e.date ? ` (${e.date})` : ""}`;
                    return /^https?:\/\//.test(e.url) ? (
                      <a key={k} href={e.url} target="_blank" rel="noreferrer noopener" className="text-sky-700 hover:underline">
                        {label} ↗
                      </a>
                    ) : (
                      <span key={k}>{label}</span>
                    );
                  })}
                </div>
              )}
              {r.error && <div className="mt-0.5 text-[11px] text-red-600">{r.error}</div>}
            </li>
          );
        })}
      </ul>
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

type GotoFn = (sectionId: string, paragraph: number, text: string) => void;
const fmtAt = (at: string | null) => (at ? new Date(at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

/** 오래 걸리는 AI 요청의 경과 초 */
function useElapsed(running: boolean) {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    if (!running) return;
    setSec(0);
    const t = setInterval(() => setSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  return sec;
}

const SEV = { high: ["중요", "bg-red-100 text-red-800"], medium: ["보통", "bg-amber-100 text-amber-800"], low: ["참고", "bg-stone-100 text-stone-600"] } as const;

/** 책 전체 일관성 — 장 요약·용어집으로 장 사이 문제를 찾는다. 저장된 결과를 먼저 보여 주고, 원고가 바뀌었을 때만 다시 점검을 권한다 */
function ConsistencyTab({ projectId, beforeEdit, onGoto, onBusy }: { projectId: string; beforeEdit: () => Promise<boolean>; onGoto: GotoFn; onBusy: (b: boolean) => void }) {
  const [data, setData] = useState<{ result: ConsistencyResult | null; at: string | null; stale: boolean } | null>(null);
  const [err, setErr] = useState("");
  const [running, setRunning] = useState(false);
  const sec = useElapsed(running);

  useEffect(() => {
    api(`/api/projects/${projectId}/consistency`).then(setData, (e) => setErr(e.message));
  }, [projectId]);

  const run = async (force: boolean) => {
    setErr("");
    setRunning(true);
    onBusy(true);
    try {
      if (!(await beforeEdit())) throw new Error("저장을 완료하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
      setData(await api(`/api/projects/${projectId}/consistency`, { method: "POST", json: { force } }));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setRunning(false);
      onBusy(false);
    }
  };

  const r = data?.result;
  return (
    <>
      <div className="flex items-center gap-2 border-b border-stone-100 px-4 py-2 text-[11px] leading-4 text-stone-500">
        <span className="flex-1">
          장·절 요약과 용어집으로 책 전체를 훑어 장 사이에서 어긋나는 사실, 되풀이한 사례, 지키지 않은 약속, 흔들리는 용어를 찾습니다. 요약이 없는 절은 먼저 요약합니다(처음엔 몇 분 걸릴 수 있음). 결과는 저장되어 다시 열어도 비용이 들지 않습니다.
        </span>
        <button className="btn-accent shrink-0 px-2.5 py-1 text-xs" disabled={running} onClick={() => run(!!r)}>
          {running ? `점검 중… ${sec}초` : r ? "다시 점검" : "점검 시작"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
        {err && <p className="mb-2 whitespace-pre-wrap text-red-600">{err}</p>}
        {!data && !err && <p className="text-stone-400">불러오는 중…</p>}
        {data && !r && !running && <p className="py-8 text-center text-stone-500">아직 점검하지 않았습니다. [점검 시작]을 누르세요.</p>}
        {r && (
          <>
            {data?.stale && (
              <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">
                점검한 뒤 원고·용어집이 바뀌었습니다. 아래는 {fmtAt(data.at)} 결과입니다 — 최신 원고로 보려면 [다시 점검]을 누르세요.
              </p>
            )}
            <p className="mb-1 text-xs text-stone-400">
              {fmtAt(data?.at ?? null)} 점검{r.coverage?.skipped ? ` · 시간 한도로 ${r.coverage.skipped}개 장은 이전 요약·목차 요지로만 봄` : ""}
            </p>
            {r.overview && <p className="mb-3 rounded-lg bg-stone-50 p-3 text-xs leading-5 text-stone-700">{r.overview}</p>}
            {!r.items.length && <p className="py-6 text-center text-stone-500">장 사이에서 눈에 띄는 일관성 문제가 없습니다. 🎉</p>}
            <ul className="space-y-2">
              {r.items.map((it, i) => (
                <li key={i} className="rounded-lg border border-stone-200 px-3 py-2 text-xs leading-5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`rounded px-1.5 text-[10px] font-semibold ${SEV[it.severity][1]}`}>{SEV[it.severity][0]}</span>
                    <span className="rounded bg-violet-50 px-1.5 text-[10px] text-violet-800">{CONSISTENCY_LABEL[it.type]}</span>
                    <span className="font-semibold text-stone-800">{it.title}</span>
                  </div>
                  {it.detail && <p className="mt-1 text-stone-600">{it.detail}</p>}
                  {it.suggestion && <p className="mt-0.5 text-stone-500">→ {it.suggestion}</p>}
                  {it.refs.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {it.refs.map((ref) => (
                        <Go key={ref.sectionId} onGoto={onGoto} sid={ref.sectionId} p={1} t="" where={`${ref.chapterTitle} > ${ref.label} ${ref.title}`}>
                          {`${ref.label} ${ref.title}`.trim().slice(0, 24)} →
                        </Go>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-stone-400">요약을 보고 찾은 결과라 세부가 틀릴 수 있습니다. [바로가기]로 원고를 확인한 뒤 고치세요.</p>
          </>
        )}
      </div>
    </>
  );
}

type Tree = { chapters: { id: string; title: string; kind: string; sections: { id: string; title: string; charCount: number }[] }[] };

/** AI 베타 리더 — 장(또는 절)을 골라 대상 독자의 눈으로 읽힌다 */
function BetaTab({ projectId, beforeEdit, onGoto, onBusy }: { projectId: string; beforeEdit: () => Promise<boolean>; onGoto: GotoFn; onBusy: (b: boolean) => void }) {
  const [tree, setTree] = useState<Tree | null>(null);
  const [chapterId, setChapterId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [data, setData] = useState<{ result: BetaResult | null; at: string | null; stale: boolean; audienceMissing?: boolean } | null>(null);
  const [err, setErr] = useState("");
  const [running, setRunning] = useState(false);
  const sec = useElapsed(running);

  useEffect(() => {
    api<Tree>(`/api/projects/${projectId}`).then(
      (t) => {
        setTree(t);
        const first = t.chapters.find((c) => c.sections.some((s) => s.charCount > 300)) ?? t.chapters[0];
        if (first) setChapterId(first.id);
      },
      (e) => setErr(e.message),
    );
  }, [projectId]);

  useEffect(() => {
    if (!chapterId) return;
    setData(null);
    setErr("");
    const q = sectionId ? `sectionId=${sectionId}` : `chapterId=${chapterId}`;
    api(`/api/projects/${projectId}/beta-reader?${q}`).then(setData, (e) => setErr(e.message));
  }, [projectId, chapterId, sectionId]);

  const run = async () => {
    setErr("");
    setRunning(true);
    onBusy(true);
    try {
      if (!(await beforeEdit())) throw new Error("저장을 완료하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
      const force = !!data?.result;
      setData(await api(`/api/projects/${projectId}/beta-reader`, { method: "POST", json: sectionId ? { sectionId, force } : { chapterId, force } }));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setRunning(false);
      onBusy(false);
    }
  };

  const chapter = tree?.chapters.find((c) => c.id === chapterId);
  const r = data?.result;
  const points = (title: string, list: BetaPoint[], tone: string) =>
    list.length > 0 && (
      <>
        <H>{title}</H>
        <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200">
          {list.map((x, i) => (
            <li key={i} className="px-3 py-1.5 text-xs leading-5">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  {x.quote && <div className={`font-book ${tone}`}>“{x.quote}”</div>}
                  {x.why && <div className="text-stone-600">{x.why}</div>}
                  {x.suggestion && <div className="text-stone-500">→ {x.suggestion}</div>}
                </div>
                {x.place && <Go onGoto={onGoto} sid={x.place.sectionId} p={x.place.paragraph} t={x.place.text} where={`${x.place.label} ${x.place.title} · ${x.place.paragraph}문단`} />}
              </div>
            </li>
          ))}
        </ul>
      </>
    );

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-stone-100 px-4 py-2 text-xs">
        <select
          className="input w-auto max-w-[14rem] py-1 text-xs"
          value={chapterId}
          disabled={running}
          onChange={(e) => {
            setChapterId(e.target.value);
            setSectionId("");
          }}
        >
          {tree?.chapters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <select className="input w-auto max-w-[14rem] py-1 text-xs" value={sectionId} disabled={running || !chapter} onChange={(e) => setSectionId(e.target.value)}>
          <option value="">장 전체</option>
          {chapter?.sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <button className="btn-accent ml-auto px-2.5 py-1 text-xs" disabled={running || !chapterId} onClick={run}>
          {running ? `읽는 중… ${sec}초` : r ? "다시 읽히기" : "베타 리더에게 읽히기"}
        </button>
      </div>
      <p className="border-b border-stone-100 px-4 py-2 text-[11px] leading-4 text-stone-500">
        책 정보의 ‘대상 독자’가 되어 읽고, 늘어지는 곳·이해 안 되는 곳·독자가 품을 질문·빼도 될 곳을 알려 줍니다. 교정이 아니라 독자 반응입니다. 같은 원고면 저장된 결과를 보여 주고 다시 청구하지 않습니다.
      </p>
      <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
        {err && <p className="mb-2 whitespace-pre-wrap text-red-600">{err}</p>}
        {data?.audienceMissing && (
          <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">
            책 정보에 대상 독자가 비어 있어 ‘일반 성인 독자’로 읽습니다.{" "}
            <a className="underline" href={`/projects/${projectId}/settings`}>
              책 설정 → 책 정보
            </a>
            에서 대상 독자를 적으면 더 정확합니다.
          </p>
        )}
        {!data && !err && <p className="text-stone-400">불러오는 중…</p>}
        {data && !r && !running && <p className="py-8 text-center text-stone-500">아직 읽히지 않았습니다. 장이나 절을 고르고 [베타 리더에게 읽히기]를 누르세요.</p>}
        {r && (
          <>
            {data?.stale && <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">읽힌 뒤 원고가 바뀌었습니다. 아래는 {fmtAt(data.at)} 결과입니다.</p>}
            <div className="rounded-lg bg-stone-50 p-3 text-xs leading-5 text-stone-700">
              {r.engagement > 0 && (
                <div className="mb-1 font-semibold text-stone-800">
                  몰입도 {"★".repeat(r.engagement)}
                  <span className="text-stone-300">{"★".repeat(5 - r.engagement)}</span>
                </div>
              )}
              {r.overall}
            </div>
            {r.strengths.length > 0 && (
              <>
                <H>좋았던 점</H>
                <ul className="list-disc space-y-0.5 pl-5 text-xs leading-5 text-emerald-800">
                  {r.strengths.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </>
            )}
            {points("늘어지는 곳", r.drags, "text-amber-800")}
            {points("이해가 안 되는 곳", r.unclear, "text-red-800")}
            {r.questions.length > 0 && (
              <>
                <H>독자가 품을 질문</H>
                <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200">
                  {r.questions.map((q, i) => (
                    <li key={i} className="flex items-start gap-2 px-3 py-1.5 text-xs leading-5">
                      <span className="flex-1 text-stone-700">❓ {q.question}</span>
                      {q.place && <Go onGoto={onGoto} sid={q.place.sectionId} p={q.place.paragraph} t={q.place.text} where={`${q.place.label} ${q.place.title} · ${q.place.paragraph}문단`} />}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {points("빼도 좋을 곳", r.cut, "text-stone-500 line-through decoration-stone-300")}
            <p className="mt-3 text-[11px] text-stone-400">{fmtAt(data?.at ?? null)} 읽음 · AI 독자의 반응이라 참고용입니다.</p>
          </>
        )}
      </div>
    </>
  );
}
