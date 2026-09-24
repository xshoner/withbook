"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, fmtDate } from "@/lib/client";

type Report = {
  id: string;
  createdAt: string;
  concept: string;
  flow: string;
  chapters: { title: string; promise: string; rationale: string; sections: { title: string; gist: string; hook: string; targetPages: number }[] }[];
  readerHooks: string[];
  differentiation: string[];
  estimatedPages: number;
  frontMatter: string[];
  backMatter: string[];
};

export default function TocDesign() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const sp = useSearchParams();
  const [reports, setReports] = useState<Report[] | null>(null);
  const [cur, setCur] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState<{ msg: string; raw?: string } | null>(null);
  const [project, setProject] = useState<any>(null);
  const started = useRef(false);

  useEffect(() => {
    api(`/api/projects/${id}`).then(setProject);
    api<Report[]>(`/api/projects/${id}/toc/reports`).then((r) => {
      setReports(r);
      if (!r.length && sp.get("auto") === "1" && !started.current) {
        started.current = true;
        design({});
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  async function design(body: { regenerate?: boolean; chapterIndex?: number; baseReportId?: string }) {
    setBusy(body.chapterIndex ? `${body.chapterIndex}장 다시 설계 중` : body.regenerate ? "다른 구성으로 설계 중" : "목차 설계 중");
    setErr(null);
    try {
      const r = await api<{ report?: Report; error?: string; raw?: string }>(`/api/projects/${id}/toc/design`, { method: "POST", json: body });
      if (r.error) setErr({ msg: r.error, raw: r.raw });
      else if (r.report) {
        setReports((rs) => [r.report!, ...(rs ?? [])]);
        setCur(0);
      }
    } catch (e: any) {
      setErr({ msg: e.message });
    } finally {
      setBusy(null);
    }
  }

  async function apply(rep: Report) {
    const r = await api<{ needConfirm?: boolean; written?: number }>(`/api/projects/${id}/toc/apply`, { method: "POST", json: { reportId: rep.id } });
    if (r.needConfirm) {
      if (!confirm(`이미 본문이 작성된 절이 ${r.written}개 있습니다. 목차를 교체하면 기존 장/절과 본문이 모두 삭제됩니다. 계속할까요?`)) return;
      await api(`/api/projects/${id}/toc/apply`, { method: "POST", json: { reportId: rep.id, force: true } });
    }
    router.push(`/projects/${id}`);
  }

  const shown = (reports ?? []).slice(0, 3);
  const rep = shown[cur];
  const sum = rep ? rep.chapters.reduce((s, c) => s + c.sections.reduce((a, x) => a + (Number(x.targetPages) || 0), 0), 0) : 0;

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-4 flex items-center justify-between">
        <Link href={`/projects/${id}`} className="btn-ghost">
          ← 집필 화면
        </Link>
        <div className="flex gap-2">
          <button className="btn" disabled={!!busy} onClick={() => design({ regenerate: true })}>
            다른 구성으로 다시
          </button>
          {rep && (
            <button className="btn-accent" disabled={!!busy} onClick={() => apply(rep)}>
              이 목차로 시작 →
            </button>
          )}
        </div>
      </div>
      <h1 className="font-bookhead text-2xl">목차 설계 보고서</h1>
      {project && <p className="mt-1 text-sm text-stone-500">『{project.title}』 · {project.topic || "주제 미입력"}</p>}

      {busy && (
        <div className="card mt-6 flex items-center gap-4 p-6">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-amber-600 border-t-transparent" />
          <div>
            <div className="font-semibold">{busy}… ({elapsed}초)</div>
            <div className="text-sm text-stone-500">분야 전문가 관점에서 최신 트렌드와 독자 흥미 포인트를 반영해 설계하고 있습니다. 장·절이 많으면 2~4분 걸립니다. 이 화면을 떠나도 설계는 계속되고, 돌아오면 결과가 보입니다.</div>
          </div>
        </div>
      )}
      {err && (
        <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          {err.msg}
          {err.raw && <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs text-stone-700">{err.raw}</pre>}
        </div>
      )}

      {reports && !reports.length && !busy && (
        <div className="card mt-6 p-8 text-center">
          <p className="mb-4 text-stone-600">아직 설계된 목차가 없습니다.</p>
          <button className="btn-accent" onClick={() => design({})}>
            AI 목차 설계 시작
          </button>
          <p className="mt-3 text-xs text-stone-400">
            또는{" "}
            <Link className="underline" href={`/projects/${id}`}>
              직접 목차 만들기
            </Link>
          </p>
        </div>
      )}

      {shown.length > 1 && (
        <div className="mt-6 flex gap-1 border-b border-stone-200">
          {shown.map((r, i) => (
            <button
              key={r.id}
              onClick={() => setCur(i)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm ${i === cur ? "border-amber-700 font-semibold text-stone-900" : "border-transparent text-stone-500"}`}
            >
              {i === 0 ? "최신안" : `이전안 ${i}`} <span className="text-xs text-stone-400">{fmtDate(r.createdAt)}</span>
            </button>
          ))}
        </div>
      )}

      {rep && (
        <div className="mt-6 space-y-6">
          <section className="card p-6">
            <h2 className="mb-2 text-sm font-bold text-amber-800">① 설계 콘셉트</h2>
            <p className="leading-7">{rep.concept}</p>
            {rep.flow && <p className="mt-3 text-sm leading-6 text-stone-600">{rep.flow}</p>}
            <div className="mt-4 flex gap-6 text-sm text-stone-500">
              <span>
                예상 총 페이지 <b className="text-stone-800">{rep.estimatedPages || sum}쪽</b>
              </span>
              <span>절 권장 분량 합계 {sum}쪽</span>
              <span>
                {rep.chapters.length}장 · {rep.chapters.reduce((s, c) => s + c.sections.length, 0)}절
              </span>
            </div>
          </section>

          <section className="card p-6">
            <h2 className="mb-4 text-sm font-bold text-amber-800">② 목차 · ③ 장별 설계 근거</h2>
            {rep.frontMatter?.length > 0 && <p className="mb-3 text-sm text-stone-500">앞붙이: {rep.frontMatter.join(", ")}</p>}
            <ol className="space-y-6">
              {rep.chapters.map((c, ci) => (
                <li key={ci} className="border-l-2 border-amber-200 pl-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="font-bookhead text-lg">
                        {ci + 1}장 {c.title}
                      </div>
                      {c.promise && <div className="text-sm text-stone-600">→ {c.promise}</div>}
                    </div>
                    <button className="btn-ghost shrink-0 text-xs" disabled={!!busy} onClick={() => design({ chapterIndex: ci + 1, baseReportId: rep.id })}>
                      이 장만 다시
                    </button>
                  </div>
                  <table className="mt-2 w-full text-sm">
                    <tbody>
                      {c.sections.map((s, si) => (
                        <tr key={si} className="border-t border-stone-100 align-top">
                          <td className="w-12 py-1.5 text-stone-400">
                            {ci + 1}.{si + 1}
                          </td>
                          <td className="py-1.5">
                            <div className="font-medium">{s.title}</div>
                            <div className="text-stone-500">{s.gist}</div>
                            {s.hook && <div className="text-xs text-amber-700">✦ {s.hook}</div>}
                          </td>
                          <td className="w-14 py-1.5 text-right text-stone-500">{s.targetPages}쪽</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {c.rationale && <p className="mt-2 rounded bg-stone-50 p-2 text-xs leading-5 text-stone-600">설계 근거 · {c.rationale}</p>}
                </li>
              ))}
            </ol>
            {rep.backMatter?.length > 0 && <p className="mt-4 text-sm text-stone-500">뒷붙이: {rep.backMatter.join(", ")}</p>}
          </section>

          <div className="grid grid-cols-2 gap-6">
            <section className="card p-6">
              <h2 className="mb-2 text-sm font-bold text-amber-800">④ 독자 흥미 포인트</h2>
              <ul className="list-disc space-y-1 pl-5 text-sm leading-6">
                {rep.readerHooks.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            </section>
            <section className="card p-6">
              <h2 className="mb-2 text-sm font-bold text-amber-800">⑤ 차별화 포인트</h2>
              <ul className="list-disc space-y-1 pl-5 text-sm leading-6">
                {rep.differentiation.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            </section>
          </div>
          <div className="flex justify-end">
            <button className="btn-accent" disabled={!!busy} onClick={() => apply(rep)}>
              이 목차로 시작 →
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
