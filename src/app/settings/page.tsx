"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AiSettingsPanel from "@/components/AiSettingsPanel";
import StyleProfileView from "@/components/StyleProfileView";
import { api, fmtDate } from "@/lib/client";
import { attachFile } from "@/lib/upload-client";
import { useMe } from "@/lib/me-client";
import { confirmDialog, toast, toastError } from "@/components/ui/feedback";

/** AI 사용 기록의 용도(purpose) → 화면 이름. src/lib/ai·src/lib/cover의 모든 purpose 값 */
const PURPOSE: Record<string, string> = {
  toc_design: "목차 설계",
  section_outline: "긴 절 개요",
  section_write: "집필",
  section_write_part: "집필(긴 절 파트)",
  length_adjust: "분량 조정",
  summary: "절 요약(앞 내용 연결)",
  chapter_summary: "장 요약(앞 내용 연결)",
  proofread: "교정·교열",
  chapter_revise: "장 퇴고",
  rewrite_polish: "부분 수정 — 다듬기",
  rewrite_expand: "부분 수정 — 늘리기",
  rewrite_shorten: "부분 수정 — 줄이기",
  rewrite_tone: "부분 수정 — 톤 바꾸기",
  rewrite_example: "부분 수정 — 예시 추가",
  rewrite_custom: "부분 수정 — 직접 지시",
  footnote: "각주 쓰기",
  footnote_auto: "각주 자동 제안",
  factcheck: "사실 확인",
  consistency: "책 전체 일관성 점검",
  beta_reader: "베타 리더",
  style_analyze: "문체 분석",
  style_learn: "작가 수정에서 문체 배우기",
  image_suggest: "이미지 추천 — 필요한 그림 고르기",
  image_pick: "이미지 추천 — 후보 고르기·캡션",
  cover_image: "표지 그림 만들기",
  cover_image_edit: "표지 그림 고치기",
  ping: "연결 점검",
};
const purposeName = (p: string) => PURPOSE[p] ?? (p.startsWith("rewrite_") ? "부분 수정" : p);
const STATUS: Record<string, string> = { ok: "성공", error: "실패", aborted: "중단" };

type Usage = {
  sum: { _count: number; _sum: { promptTokens: number | null; completionTokens: number | null; cost: number | null } };
  byPurpose: { purpose: string; _count: number; _sum: { promptTokens: number | null; completionTokens: number | null; cost: number | null } }[];
  recent: { id: string; createdAt: string; purpose: string; status: string; promptTokens: number; completionTokens: number; ms: number; instructionIncluded: boolean; error?: string | null; cost: number }[];
};
type Book = { id: string; title: string; deletedAt: string | null };

export default function Settings() {
  const me = useMe();
  const admin = me?.role === "superadmin";
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageErr, setUsageErr] = useState("");
  const [books, setBooks] = useState<Book[]>([]);
  const [bookFilter, setBookFilter] = useState("");
  const [ins, setIns] = useState<{ path: string; text: string; history: string[] } | null>(null);
  const [insErr, setInsErr] = useState("");
  const [insText, setInsText] = useState("");
  const [savingIns, setSavingIns] = useState(false);
  const [style, setStyle] = useState<any>(null);
  const [styleErr, setStyleErr] = useState("");
  const [busy, setBusy] = useState("");

  const loadStyle = () =>
    api("/api/style/global").then(
      (r) => {
        setStyle(r);
        setStyleErr("");
      },
      (e) => setStyleErr(e.message),
    );
  const loadIns = () =>
    api("/api/instruction").then(
      (r) => {
        setIns(r);
        setInsText(r.text);
        setInsErr("");
      },
      (e) => setInsErr(e.message),
    );
  useEffect(() => {
    loadIns();
    loadStyle();
    api<Book[]>("/api/projects").then(setBooks, () => {});
  }, []);
  useEffect(() => {
    setUsage(null);
    setUsageErr("");
    api<Usage>(`/api/ai/usage${bookFilter ? `?projectId=${encodeURIComponent(bookFilter)}` : ""}`).then(setUsage, (e) => setUsageErr(e.message));
  }, [bookFilter]);

  const saveIns = async () => {
    setSavingIns(true);
    try {
      await api("/api/instruction", { method: "PUT", json: { text: insText } });
      await loadIns();
      toast.success("서술 규칙(instruction.md)을 저장했습니다. 다음 AI 요청부터 적용됩니다.");
    } catch (e) {
      toastError(e, "서술 규칙을 저장하지 못했습니다: ");
    } finally {
      setSavingIns(false);
    }
  };

  const byPurpose = [...(usage?.byPurpose ?? [])].sort((a, b) => (b._sum.cost ?? 0) - (a._sum.cost ?? 0) || b._count - a._count);

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <Link href="/projects" className="btn-ghost">
        ← 책 목록
      </Link>
      <h1 className="font-bookhead text-2xl">설정</h1>
      <p className="-mt-4 text-sm text-stone-500">여기 설정은 모든 책에 공통입니다. 책마다 다른 값(책 정보·이 책의 문체·조판·용어집)은 각 책의 [책 설정]에서 바꿉니다.</p>

      <section className="card p-6">
        <h2 className="mb-3 font-semibold">AI 연결 (모든 책 공통)</h2>
        {me && !admin && <p className="mb-3 rounded bg-stone-50 px-3 py-2 text-xs text-stone-600">AI 연결은 관리자만 바꿀 수 있습니다. 지금 연결 상태 확인과 연결 점검은 할 수 있습니다.</p>}
        <AiSettingsPanel />
      </section>

      <section id="style" className="card p-6">
        <h2 className="mb-1 font-semibold">작가 기본 문체 학습 (새 책에 자동 적용)</h2>
        <p className="mb-3 text-sm text-stone-500">
          작가가 쓴 글을 올리고 학습하면 <b>기본 문체</b>가 만들어져 앞으로 만드는 새 책에 자동으로 들어갑니다. 이미 있는 책의 문체는 바뀌지 않습니다 — 그 책의 [책 설정 → 문체]에서 기본 문체를 다시 적용하거나 그 책만의 문체로 따로 고칩니다. 글을 더 올리고 [다시 학습]을 누르면 기존 자료와 합쳐 학습합니다.
        </p>
        {me && !admin && <p className="mb-3 rounded bg-stone-50 px-3 py-2 text-xs text-stone-600">학습 자료 올리기·빼기·다시 학습은 관리자만 할 수 있습니다.</p>}
        {styleErr && <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">학습 자료를 불러오지 못했습니다: {styleErr}</p>}
        <ul className="mb-3 divide-y divide-stone-100 rounded border border-stone-200 text-sm text-stone-600">
          {style?.files.map((f: any) => (
            <li key={f.name} className="flex items-center gap-2 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="text-xs text-stone-400">{Math.round(f.size / 1024).toLocaleString()}KB</span>
              {admin && (
                <button
                  className="text-xs text-red-600 hover:underline"
                  disabled={!!busy}
                  onClick={async () => {
                    if (!(await confirmDialog(`학습 자료에서 「${f.name}」을(를) 뺄까요? (이미 학습된 문체는 다시 학습할 때 바뀝니다)`, { okLabel: "빼기" }))) return;
                    try {
                      await api(`/api/style/global?name=${encodeURIComponent(f.name)}`, { method: "DELETE" });
                      await loadStyle();
                    } catch (e) {
                      toastError(e, "학습 자료를 빼지 못했습니다: ");
                    }
                  }}
                >
                  빼기
                </button>
              )}
            </li>
          ))}
          {style && !style.files?.length && <li className="px-3 py-2 text-stone-400">학습 자료가 없습니다.</li>}
          {!style && !styleErr && <li className="px-3 py-2 text-stone-400">불러오는 중…</li>}
        </ul>
        {admin && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border-2 border-dashed border-stone-300 bg-stone-50 px-4 py-3">
              <input
                id="ref-files"
                type="file"
                multiple
                accept=".txt,.md,.docx,.hwpx,.pdf"
                className="sr-only"
                onChange={async (e) => {
                  const list = [...(e.target.files ?? [])];
                  e.target.value = "";
                  if (!list.length) return;
                  setBusy("upload");
                  try {
                    const fd = new FormData();
                    for (const f of list) await attachFile(fd, "files", f);
                    await api("/api/style/global", { method: "PUT", body: fd });
                    await loadStyle();
                    toast.success(`학습 자료 ${list.length}개를 올렸습니다. [다시 학습]을 누르면 반영됩니다.`);
                  } catch (er: any) {
                    toastError(er);
                  } finally {
                    setBusy("");
                  }
                }}
              />
              <label htmlFor="ref-files" className="btn-primary cursor-pointer">
                📁 학습 자료 올리기
              </label>
              <span className="text-sm text-stone-500">{busy === "upload" ? "올리는 중…" : "txt · md · pdf · docx · hwpx, 여러 개 가능"}</span>
            </div>
            <button
              className="btn-accent"
              disabled={busy === "style"}
              onClick={async () => {
                setBusy("style");
                try {
                  const r = await api("/api/style/global", { method: "POST" });
                  if (r.error) toast.error(r.error);
                  else toast.success("기본 문체를 다시 학습했습니다. 새로 만드는 책부터 적용됩니다.");
                  await loadStyle();
                } catch (e: any) {
                  toastError(e);
                } finally {
                  setBusy("");
                }
              }}
            >
              {busy === "style" ? "학습 중… (1~3분)" : style?.global ? "다시 학습" : "문체 학습 시작"}
            </button>
          </>
        )}
        {style?.global && (
          <div className="mt-5 border-t border-stone-100 pt-4">
            <p className="mb-3 text-xs text-stone-500">
              학습: {fmtDate(style.global.analyzedAt)} · {style.global.files.join(" / ")}
            </p>
            <StyleProfileView profile={style.global.profile} />
          </div>
        )}
        {admin && style?.dir && (
          <details className="mt-3 text-xs text-stone-400">
            <summary className="cursor-pointer">고급 — 자료 보관 위치</summary>
            <code>{style.dir}</code>
          </details>
        )}
      </section>

      <section className="card p-6">
        <h2 className="mb-1 font-semibold">서술 기본 규칙 (instruction.md)</h2>
        <p className="mb-3 text-sm text-stone-500">
          집필·교정·부분 수정 요청마다 전문이 AI에게 전달됩니다. 저장하면 바로 반영되고, 이전 내용은 최근 20개까지 보관됩니다.
          {ins?.path && <span className="ml-1 text-xs text-stone-400">({ins.path})</span>}
        </p>
        {insErr && (
          <p className="mb-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            규칙을 불러오지 못했습니다: {insErr}{" "}
            <button className="underline" onClick={loadIns}>
              다시 시도
            </button>
          </p>
        )}
        {!ins && !insErr && <p className="text-sm text-stone-400">불러오는 중…</p>}
        {ins && (
          <>
            <textarea className="input min-h-[420px] font-mono text-xs leading-5" value={insText} readOnly={!admin} onChange={(e) => setInsText(e.target.value)} />
            <div className="mt-2 flex items-center gap-3">
              {admin ? (
                <button className="btn-primary" disabled={insText === ins.text || savingIns} onClick={saveIns}>
                  {savingIns ? "저장 중…" : "저장"}
                </button>
              ) : (
                <span className="text-xs text-stone-500">서술 규칙은 관리자만 고칠 수 있습니다.</span>
              )}
              {ins.history.length ? <span className="text-xs text-stone-400">이전 버전 {ins.history.length}개 보관 중</span> : null}
            </div>
          </>
        )}
      </section>

      <section className="card p-6">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="font-semibold">AI 사용량</h2>
          <select className="input ml-auto w-auto py-1 text-sm" value={bookFilter} onChange={(e) => setBookFilter(e.target.value)} aria-label="책별로 보기">
            <option value="">모든 책</option>
            {books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title}
                {b.deletedAt ? " (휴지통)" : ""}
              </option>
            ))}
          </select>
        </div>
        <p className="mb-3 text-xs leading-5 text-stone-500">
          <b>비용</b>은 AI 게이트웨이가 응답마다 알려 준 추정 비용(estimated_cost)을 그대로 더한 값이며, 단위는 게이트웨이의 청구 단위(보통 미국 달러)입니다. 원화 금액이 아닙니다. Gemini·OpenAI처럼 직접 연결한 제공자는 비용을 알려 주지 않아 0으로 기록되므로, 실제 청구액은 각 제공자의 결제 화면에서 확인하세요. 토큰은 AI가 읽은 양(입력)과 쓴 양(출력)입니다.
        </p>
        {usageErr && <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">사용량을 불러오지 못했습니다: {usageErr}</p>}
        {!usage && !usageErr && <p className="text-sm text-stone-400">불러오는 중…</p>}
        {usage && (
          <>
            <div className="mb-4 grid grid-cols-2 gap-3 text-center text-sm sm:grid-cols-4">
              <div className="rounded bg-stone-50 p-3">
                <div className="text-xs text-stone-500">호출</div>
                <div className="text-lg font-semibold">{usage.sum._count.toLocaleString()}</div>
              </div>
              <div className="rounded bg-stone-50 p-3">
                <div className="text-xs text-stone-500">입력 토큰</div>
                <div className="text-lg font-semibold">{(usage.sum._sum.promptTokens ?? 0).toLocaleString()}</div>
              </div>
              <div className="rounded bg-stone-50 p-3">
                <div className="text-xs text-stone-500">출력 토큰</div>
                <div className="text-lg font-semibold">{(usage.sum._sum.completionTokens ?? 0).toLocaleString()}</div>
              </div>
              <div className="rounded bg-stone-50 p-3">
                <div className="text-xs text-stone-500">추정 비용 (게이트웨이 청구 단위)</div>
                <div className="text-lg font-semibold">{(usage.sum._sum.cost ?? 0).toFixed(2)}</div>
              </div>
            </div>
            {!byPurpose.length && <p className="mb-4 text-sm text-stone-400">기록된 AI 호출이 없습니다.</p>}
            {byPurpose.length > 0 && (
              <table className="mb-4 w-full text-sm">
                <thead className="text-left text-xs text-stone-500">
                  <tr>
                    <th>용도</th>
                    <th className="text-right">호출</th>
                    <th className="text-right">입력 토큰</th>
                    <th className="text-right">출력 토큰</th>
                    <th className="text-right">추정 비용</th>
                  </tr>
                </thead>
                <tbody>
                  {byPurpose.map((b) => (
                    <tr key={b.purpose} className="border-t border-stone-100">
                      <td className="py-1">{purposeName(b.purpose)}</td>
                      <td className="text-right">{b._count.toLocaleString()}</td>
                      <td className="text-right">{(b._sum.promptTokens ?? 0).toLocaleString()}</td>
                      <td className="text-right">{(b._sum.completionTokens ?? 0).toLocaleString()}</td>
                      <td className="text-right">{(b._sum.cost ?? 0).toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <details>
              <summary className="cursor-pointer text-sm text-stone-600">최근 호출 50건</summary>
              <table className="mt-2 w-full text-xs">
                <thead className="text-left text-stone-500">
                  <tr>
                    <th>시각</th>
                    <th>용도</th>
                    <th>결과</th>
                    <th className="text-right">토큰(입/출)</th>
                    <th className="text-right">시간</th>
                    {admin && <th className="text-center" title="서술 규칙(instruction.md)이 요청에 들어갔는지 — 관리자용">규칙 포함</th>}
                  </tr>
                </thead>
                <tbody>
                  {usage.recent.map((r) => (
                    <tr key={r.id} className="border-t border-stone-100" title={admin ? (r.error ?? "") : ""}>
                      <td className="py-1">{fmtDate(r.createdAt)}</td>
                      <td>{purposeName(r.purpose)}</td>
                      <td className={r.status === "ok" ? "text-emerald-700" : "text-red-600"}>{STATUS[r.status] ?? r.status}</td>
                      <td className="text-right">
                        {r.promptTokens.toLocaleString()}/{r.completionTokens.toLocaleString()}
                      </td>
                      <td className="text-right">{(r.ms / 1000).toFixed(1)}초</td>
                      {admin && <td className="text-center">{r.instructionIncluded ? "✓" : "–"}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        )}
      </section>
    </main>
  );
}
