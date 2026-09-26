"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client";
import { numberChapters, type LayoutSettings } from "@/lib/layout";
import { buildPlan, type AutoItem, type AutoOptions, type PlanSection } from "@/lib/autowrite";
import { confirmDialog } from "../ui/feedback";

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

/**
 * 전체 자동 집필 시작 — 준비 상태(책 정보·목차·추가 지시·AI 연결)를 점검하고 옵션을 정한다.
 * 절마다 집필 → 팩트체크 → 검수를 책 순서대로 진행한다(집필은 점검을 기다리지 않고 다음 절로).
 */
export default function AutoWriteDialog(props: {
  projectId: string;
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

  useEffect(() => {
    api<Project>(`/api/projects/${props.projectId}`).then(setP).catch((e) => setErr(e.message));
    for (const scope of ["writing", "factcheck", "revision"] as const)
      api<Conn>(`/api/ai/settings?scope=${scope}`)
        .then((c) => setConn((x) => ({ ...x, [scope]: c })))
        .catch(() => {});
  }, [props.projectId]);

  const sections: PlanSection[] = useMemo(() => {
    if (!p) return [];
    return numberChapters(p.chapters, p.layout.numberFormat).flatMap((c) =>
      c.sections.map((s) => ({ id: s.id, label: s.label, title: s.title, chapterTitle: c.title, chapterKind: c.kind, targetPages: s.targetPages, charCount: s.charCount })),
    );
  }, [p]);
  const options: AutoOptions = { extraInstruction: noExtra ? "" : extra.trim(), factcheck, review, reviewLevel: level, rewrite, charsPerPage: p?.charsPerPage };
  const plan = useMemo(() => buildPlan(sections, options, matter), [sections, rewrite, matter, factcheck, review, level, extra, noExtra]); // eslint-disable-line react-hooks/exhaustive-deps
  const toWrite = plan.filter((x) => x.write === "pending");
  const overwrite = toWrite.filter((x) => (sections.find((s) => s.id === x.sectionId)?.charCount ?? 0) > 0);
  const pages = toWrite.reduce((a, x) => a + x.targetPages, 0);
  const noGist = sections.filter((s) => (matter || s.chapterKind === "body") && !p?.chapters.flatMap((c) => c.sections).find((x) => x.id === s.id)?.gist.trim()).length;

  const checks: { ok: boolean; warn?: boolean; label: string; detail: string; fix?: React.ReactNode }[] = p
    ? [
        {
          ok: !!(p.title.trim() && p.topic.trim() && p.intent.trim() && p.audience.trim()),
          label: "프로젝트 설정",
          detail: p.topic.trim() && p.intent.trim() && p.audience.trim() ? "제목·주제·집필 의도·대상 독자가 있습니다" : "주제·집필 의도·대상 독자를 채워야 합니다",
          fix: <Link className="underline" href={`/projects/${props.projectId}/settings`}>책 설정 열기</Link>,
        },
        {
          ok: plan.length > 0,
          warn: noGist > 0,
          label: "목차",
          detail: plan.length ? `${plan.length}개 절${noGist ? ` · 요지가 빈 절 ${noGist}개(스케치·요지 없이 제목만으로 씁니다)` : ""}` : "집필할 절이 없습니다",
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
          ? [{ ok: !!conn.factcheck?.hasKey, warn: !!conn.factcheck?.inherited, label: "팩트체크 AI", detail: conn.factcheck ? `${conn.factcheck.model}${conn.factcheck.inherited ? " (기본 연결 — 팩트체크 전용 연결을 권장)" : ""}${conn.factcheck.hasKey ? "" : " — API 키 없음"}` : "확인 중…" }]
          : []),
        ...(review
          ? [{ ok: !!conn.revision?.hasKey, label: "검수 AI", detail: conn.revision ? `${conn.revision.model}${conn.revision.inherited ? " (기본 연결)" : ""}${conn.revision.hasKey ? "" : " — API 키 없음"}` : "확인 중…" }]
          : []),
      ]
    : [];
  const ready = !!p && checks.every((c) => c.ok) && plan.length > 0;

  const start = async () => {
    if (!ready) return;
    const msg = [
      `${plan.length}개 절을 책 순서대로 자동 진행합니다 (집필 ${toWrite.length}개, 약 ${Math.round(pages)}쪽).`,
      overwrite.length ? `이미 본문이 있는 ${overwrite.length}개 절은 지금 본문을 버전 기록에 보관한 뒤 새로 씁니다.` : "",
      "진행 중에는 이 창(탭)을 열어 두세요. 닫히거나 연결이 끊겨도 다시 열면 이어서 진행합니다.",
    ]
      .filter(Boolean)
      .join("\n");
    if (!(await confirmDialog(msg, { okLabel: "전체 자동 집필 시작" }))) return;
    props.onStart(plan, options);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4" onMouseDown={props.onClose}>
      <div className="flex max-h-[90vh] w-[720px] max-w-full flex-col rounded-xl bg-white shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="border-b border-stone-200 px-5 py-3">
          <h2 className="font-semibold">전체 자동 집필</h2>
          <p className="text-xs leading-5 text-stone-500">
            첫 장부터 마지막 장까지 절마다 <b>집필 → 팩트체크 → 검수</b>를 AI가 차례로 진행합니다. 집필 AI는 한 절을 마치면 점검을 기다리지 않고 바로 다음 절을 쓰고, 팩트체크·검수
            AI는 집필이 끝난 절을 순서대로 이어받습니다. 끊기거나 오류가 나면 자동으로 다시 시도하고, 창을 다시 열면 멈춘 곳부터 이어 갑니다.
          </p>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4 text-sm">
          {err && <p className="text-red-600">{err}</p>}
          {!p && !err && <p className="text-stone-400">불러오는 중…</p>}
          {p && (
            <>
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
                    <span className="block text-stone-500">끄면 본문이 있는 절은 집필을 건너뛰고 팩트체크·검수만 합니다</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 rounded-lg border border-stone-200 p-2.5">
                  <input type="checkbox" className="mt-0.5" checked={matter} onChange={(e) => setMatter(e.target.checked)} />
                  <span>
                    <b>앞붙이·뒷붙이 포함</b>
                    <span className="block text-stone-500">머리말·맺음말 등도 순서대로 씁니다</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 rounded-lg border border-stone-200 p-2.5">
                  <input type="checkbox" className="mt-0.5" checked={factcheck} onChange={(e) => setFactcheck(e.target.checked)} />
                  <span>
                    <b>팩트체크</b>
                    <span className="block text-stone-500">[확인 필요] 문장을 최신 자료로 판정 — 통과는 표시 삭제, 보완은 문장 대체</span>
                  </span>
                </label>
                <div className="flex items-start gap-2 rounded-lg border border-stone-200 p-2.5">
                  <input type="checkbox" className="mt-0.5" checked={review} onChange={(e) => setReview(e.target.checked)} aria-label="검수" />
                  <span className="flex-1">
                    <b>검수</b>
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
            ⚡ 전체 자동 집필 시작
          </button>
        </div>
      </div>
    </div>
  );
}
