"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { numberChapters, type LayoutSettings } from "@/lib/layout";
import { buildPlan, type AutoItem, type AutoOptions, type PlanSection } from "@/lib/autowrite";
import { confirmDialog, toastError } from "../ui/feedback";

type Project = {
  title: string;
  topic: string;
  intent: string;
  audience: string;
  keyMessage: string;
  charsPerPage: number;
  layout: LayoutSettings;
  chapters: { id: string; title: string; order: number; kind: "front" | "body" | "back"; sections: { id: string; title: string; order: number; gist: string; targetPages: number; charCount: number }[] }[];
};
type Conn = { model: string; hasKey: boolean; inherited: boolean };

type Range = "sections" | "chapter" | "book";

/**
 * 자동 집필 시작 — 범위(고른 절 · 한 장 · 책 전체)를 고르고, 준비 상태(책 정보·목차·추가 지시·AI 연결)를 점검하고 옵션을 정한다.
 * 절마다 집필 → 사실 확인 → 교정을 책 순서대로 진행한다(집필은 점검을 기다리지 않고 다음 절로). 끊기면 멈춘 곳부터 이어 간다.
 * (예전의 '다중 집필'은 이 창의 [절 고르기] 범위로 합쳤다)
 */
export default function AutoWriteDialog(props: {
  projectId: string;
  /** 지금 연 절·장 — 범위의 처음 값 */
  currentSectionId: string;
  currentChapterId: string;
  initialExtra: string;
  recentExtra: string[];
  onClose: () => void;
  onStart: (items: AutoItem[], options: AutoOptions) => void;
}) {
  const [p, setP] = useState<Project | null>(null);
  const [conn, setConn] = useState<Record<"writing" | "factcheck" | "revision", Conn | null>>({ writing: null, factcheck: null, revision: null });
  const [err, setErr] = useState("");
  const [extra, setExtra] = useState(props.initialExtra);
  const [noExtra, setNoExtra] = useState(false);
  const [rewrite, setRewrite] = useState(false);
  const [matter, setMatter] = useState(false);
  const [factcheck, setFactcheck] = useState(true);
  const [review, setReview] = useState(true);
  const [level, setLevel] = useState<"proof" | "light">("light");
  const [range, setRange] = useState<Range>("sections");
  const [picked, setPicked] = useState<string[]>([props.currentSectionId]);
  const [chapterId, setChapterId] = useState(props.currentChapterId);

  useEffect(() => {
    api<Project>(`/api/projects/${props.projectId}`).then(setP).catch((e) => setErr(e.message));
    let warned = false;
    for (const scope of ["writing", "factcheck", "revision"] as const)
      api<Conn>(`/api/ai/settings?scope=${scope}`)
        .then((c) => setConn((x) => ({ ...x, [scope]: c })))
        .catch((e) => {
          if (warned) return;
          warned = true;
          toastError(e, "AI 연결 상태를 확인하지 못했습니다: ");
        });
  }, [props.projectId]);

  const numbered = useMemo(() => (p ? numberChapters(p.chapters, p.layout.numberFormat) : []), [p]);
  const sections: PlanSection[] = useMemo(
    () => numbered.flatMap((c) => c.sections.map((s) => ({ id: s.id, label: s.label, title: s.title, chapterTitle: c.title, chapterKind: c.kind, targetPages: s.targetPages, charCount: s.charCount }))),
    [numbered],
  );
  // 범위 → 할 절 (책 전체는 앞붙이·뒷붙이 옵션을 따른다)
  const only = useMemo(
    () => (range === "sections" ? picked : range === "chapter" ? (numbered.find((c) => c.id === chapterId)?.sections.map((s) => s.id) ?? []) : undefined),
    [range, picked, chapterId, numbered],
  );
  const options: AutoOptions = { extraInstruction: noExtra ? "" : extra.trim(), factcheck, review, reviewLevel: level, rewrite, charsPerPage: p?.charsPerPage };
  const plan = useMemo(() => buildPlan(sections, options, matter, only), [sections, rewrite, matter, factcheck, review, level, extra, noExtra, only]); // eslint-disable-line react-hooks/exhaustive-deps
  const togglePick = (id: string) => setPicked((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  const toWrite = plan.filter((x) => x.write === "pending");
  const overwrite = toWrite.filter((x) => (sections.find((s) => s.id === x.sectionId)?.charCount ?? 0) > 0);
  const pages = toWrite.reduce((a, x) => a + x.targetPages, 0);
  const planIds = new Set(plan.map((x) => x.sectionId));
  const noGist = sections.filter((s) => planIds.has(s.id) && !p?.chapters.flatMap((c) => c.sections).find((x) => x.id === s.id)?.gist.trim()).length;

  const checks: { ok: boolean; warn?: boolean; label: string; detail: string; fix?: React.ReactNode }[] = p
    ? [
        {
          ok: !!(p.title.trim() && p.topic.trim() && p.intent.trim() && p.audience.trim()),
          label: "책 설정",
          detail: p.topic.trim() && p.intent.trim() && p.audience.trim() ? "제목·주제·집필 의도·대상 독자가 있습니다" : "주제·집필 의도·대상 독자를 채워야 합니다",
          fix: <Link className="underline" href={`/projects/${props.projectId}/settings`}>책 설정 열기</Link>,
        },
        {
          ok: plan.length > 0,
          warn: noGist > 0,
          label: "목차",
          detail: plan.length ? `${plan.length}개 절${noGist ? ` · 요지가 빈 절 ${noGist}개(스케치·요지 없이 제목만으로 씁니다)` : ""}` : range === "sections" ? "위 범위에서 절을 하나 이상 고르세요" : "집필할 절이 없습니다",
          fix: <Link className="underline" href={`/projects/${props.projectId}/toc`}>목차 열기</Link>,
        },
        { ok: noExtra || !!extra.trim(), label: "집필 추가 지시", detail: noExtra ? "추가 지시 없이 진행" : extra.trim() ? "모든 절에 적용합니다" : "아래에 추가 지시를 입력하거나 ‘추가 지시 없이’를 고르세요" },
        {
          ok: !!conn.writing?.hasKey,
          label: "집필 AI",
          detail: conn.writing ? `${conn.writing.model}${conn.writing.inherited ? " (기본 연결)" : ""}${conn.writing.hasKey ? "" : " — API 키 없음"}` : "확인 중…",
          fix: <Link className="underline" href={`/projects/${props.projectId}/settings`}>AI 설정</Link>,
        },
        ...(factcheck
          ? [{ ok: !!conn.factcheck?.hasKey, warn: !!conn.factcheck?.inherited, label: "사실 확인 AI", detail: conn.factcheck ? `${conn.factcheck.model}${conn.factcheck.inherited ? " (기본 연결 — 사실 확인 전용 연결을 권장)" : ""}${conn.factcheck.hasKey ? "" : " — API 키 없음"}` : "확인 중…" }]
          : []),
        ...(review
          ? [{ ok: !!conn.revision?.hasKey, label: "교정 AI", detail: conn.revision ? `${conn.revision.model}${conn.revision.inherited ? " (기본 연결)" : ""}${conn.revision.hasKey ? "" : " — API 키 없음"}` : "확인 중…" }]
          : []),
      ]
    : [];
  const ready = !!p && checks.every((c) => c.ok) && plan.length > 0;

  const start = async () => {
    if (!ready) return;
    const msg = [
      `${range === "book" ? "책 전체" : range === "chapter" ? "이 장" : "고른 절"} ${plan.length}개 절을 책 순서대로 자동 진행합니다 (집필 ${toWrite.length}개, 약 ${Math.round(pages)}쪽).`,
      overwrite.length ? `이미 본문이 있는 ${overwrite.length}개 절은 지금 본문을 버전 기록에 보관한 뒤 새로 씁니다.` : "",
      "진행 중에는 이 창(탭)을 열어 두세요. 닫히거나 연결이 끊겨도 다시 열면 이어서 진행합니다.",
    ]
      .filter(Boolean)
      .join("\n");
    if (!(await confirmDialog(msg, { okLabel: "자동 집필 시작" }))) return;
    props.onStart(plan, options);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4" onMouseDown={props.onClose}>
      <div className="flex max-h-[90vh] w-[720px] max-w-full flex-col rounded-xl bg-white shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="border-b border-stone-200 px-5 py-3">
          <h2 className="font-semibold">자동 집필</h2>
          <p className="text-xs leading-5 text-stone-500">
            범위(고른 절 · 한 장 · 책 전체)를 고르면 절마다 <b>집필 → 사실 확인 → 교정</b>을 AI가 책 순서대로 진행합니다. 집필 AI는 한 절을 마치면 점검을 기다리지 않고 바로 다음 절을 쓰고,
            사실 확인·교정 AI는 집필이 끝난 절을 순서대로 이어받습니다. 끊기거나 오류가 나면 자동으로 다시 시도하고, 창을 다시 열면 멈춘 곳부터 이어 갑니다.
          </p>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4 text-sm">
          {err && <p className="text-red-600">{err}</p>}
          {!p && !err && <p className="text-stone-400">불러오는 중…</p>}
          {p && (
            <>
              <section>
                <h3 className="mb-1.5 text-xs font-semibold text-stone-700">범위</h3>
                <div className="flex flex-wrap gap-3 text-xs" role="radiogroup" aria-label="자동 집필 범위">
                  {(
                    [
                      ["sections", "절 고르기"],
                      ["chapter", "한 장"],
                      ["book", "책 전체"],
                    ] as const
                  ).map(([v, l]) => (
                    <label key={v} className="flex items-center gap-1">
                      <input type="radio" name="auto-range" checked={range === v} onChange={() => setRange(v)} /> {l}
                    </label>
                  ))}
                </div>
                {range === "chapter" && (
                  <select className="input mt-1.5 py-1 text-xs" aria-label="장" value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
                    {numbered.map((c) => (
                      <option key={c.id} value={c.id}>
                        {`${c.label} ${c.title}`.trim()} ({c.sections.length}개 절)
                      </option>
                    ))}
                  </select>
                )}
                {range === "book" && (
                  <label className="mt-1.5 flex items-center gap-1.5 text-xs text-stone-600">
                    <input type="checkbox" checked={matter} onChange={(e) => setMatter(e.target.checked)} /> 앞붙이·뒷붙이(머리말·맺음말 등)도 순서대로 씁니다
                  </label>
                )}
                {range === "sections" && (
                  <div className="mt-1.5 max-h-48 overflow-auto rounded-lg border border-stone-200 text-xs">
                    {numbered.map((c) => (
                      <div key={c.id}>
                        <div className="sticky top-0 bg-stone-50 px-3 py-1 font-semibold text-stone-600">{`${c.label} ${c.title}`.trim()}</div>
                        {c.sections.map((sec) => (
                          <label key={sec.id} className="flex cursor-pointer items-center gap-2 px-3 py-1 hover:bg-stone-50">
                            <input type="checkbox" checked={picked.includes(sec.id)} onChange={() => togglePick(sec.id)} />
                            <span className="shrink-0 text-stone-400">{sec.label}</span>
                            <span className="min-w-0 flex-1 truncate">{sec.title}</span>
                            {sec.id === props.currentSectionId && <span className="rounded bg-stone-800 px-1.5 text-[10px] text-white">지금 절</span>}
                            {sec.charCount > 0 && <span className="shrink-0 text-[10px] text-stone-400">본문 {sec.charCount.toLocaleString()}자</span>}
                          </label>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <h3 className="mb-1.5 text-xs font-semibold text-stone-700">준비 점검</h3>
                <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200">
                  {checks.map((c) => (
                    <li key={c.label} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                      <span className={`w-4 shrink-0 text-center font-bold ${!c.ok ? "text-red-600" : c.warn ? "text-amber-600" : "text-green-600"}`}>{!c.ok ? "✕" : c.warn ? "!" : "✓"}</span>
                      <span className="w-24 shrink-0 font-semibold text-stone-700">{c.label}</span>
                      <span className="min-w-0 flex-1 text-stone-500">{c.detail}</span>
                      {!c.ok && c.fix && <span className="shrink-0 text-stone-600">{c.fix}</span>}
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <label className="mb-1 block text-xs font-semibold text-stone-700" htmlFor="auto-extra">
                  집필 추가 지시 <span className="font-normal text-stone-400">— 모든 절에 적용</span>
                </label>
                <textarea
                  id="auto-extra"
                  className="input min-h-[64px] text-xs"
                  disabled={noExtra}
                  placeholder="예: 사례는 국내 현장 위주로, 절 끝은 독자에게 던지는 질문으로"
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                />
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <label className="mr-2 flex items-center gap-1 text-[11px] text-stone-500">
                    <input type="checkbox" checked={noExtra} onChange={(e) => setNoExtra(e.target.checked)} /> 추가 지시 없이
                  </label>
                  {props.recentExtra.map((r) => (
                    <button
                      key={r}
                      title={r}
                      onClick={() => {
                        setExtra(r);
                        setNoExtra(false);
                      }}
                      className={`max-w-[220px] truncate rounded-full border px-2 py-0.5 text-[11px] ${r === extra.trim() ? "border-amber-500 bg-amber-50 text-amber-900" : "border-stone-300 text-stone-600 hover:bg-stone-50"}`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </section>

              <section className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                <label className="flex items-start gap-2 rounded-lg border border-stone-200 p-2.5">
                  <input type="checkbox" className="mt-0.5" checked={rewrite} onChange={(e) => setRewrite(e.target.checked)} />
                  <span>
                    <b>본문이 있는 절도 새로 쓰기</b>
                    <span className="block text-stone-500">끄면 본문이 있는 절은 집필을 건너뛰고 사실 확인·교정만 합니다</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 rounded-lg border border-stone-200 p-2.5">
                  <input type="checkbox" className="mt-0.5" checked={factcheck} onChange={(e) => setFactcheck(e.target.checked)} />
                  <span>
                    <b>사실 확인</b>
                    <span className="block text-stone-500">[확인 필요] 문장을 최신 자료로 확인 — 맞으면 표시 삭제, 보완이 필요하면 문장 대체</span>
                  </span>
                </label>
                <div className="flex items-start gap-2 rounded-lg border border-stone-200 p-2.5">
                  <input type="checkbox" className="mt-0.5" checked={review} onChange={(e) => setReview(e.target.checked)} aria-label="교정" />
                  <span className="flex-1">
                    <b>교정</b>
                    <span className="block text-stone-500">맞춤법·띄어쓰기·표기를 고칩니다 (절을 열면 [교정 내역]에서 되돌리기)</span>
                    <select className="input mt-1 py-0.5 text-xs" disabled={!review} value={level} onChange={(e) => setLevel(e.target.value as "proof" | "light")}>
                      <option value="light">교정 + 가벼운 교열 (비문·중복·번역투)</option>
                      <option value="proof">교정만</option>
                    </select>
                  </span>
                </div>
              </section>

              <section>
                <h3 className="mb-1.5 text-xs font-semibold text-stone-700">
                  진행 순서 <span className="font-normal text-stone-400">— 집필 {toWrite.length}개 절 · 약 {Math.round(pages)}쪽</span>
                </h3>
                <ol className="max-h-48 divide-y divide-stone-100 overflow-auto rounded-lg border border-stone-200 text-xs">
                  {plan.map((x, i) => (
                    <li key={x.sectionId} className="flex items-center gap-2 px-3 py-1">
                      <span className="w-6 shrink-0 text-right text-stone-400">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate">{x.label}</span>
                      <span className="shrink-0 text-stone-400">{x.chapterTitle}</span>
                      <span className={`shrink-0 rounded px-1.5 text-[10px] ${x.write === "pending" ? "bg-amber-100 text-amber-800" : "bg-stone-100 text-stone-500"}`}>
                        {x.write === "pending" ? `${x.targetPages}쪽 집필` : "집필 건너뜀"}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-stone-200 px-5 py-3">
          <span className="text-xs text-stone-500">{ready ? "준비가 끝났습니다." : "준비 점검의 ✕ 항목을 먼저 해결하세요."}</span>
          <button className="btn ml-auto" onClick={props.onClose}>
            취소
          </button>
          <button className="btn-accent" disabled={!ready} onClick={start}>
            ⚡ 자동 집필 시작
          </button>
        </div>
      </div>
    </div>
  );
}
