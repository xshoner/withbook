"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, fmtDate } from "@/lib/client";
import { confirmDialog } from "@/components/ui/feedback";
import { stripChapterNo } from "@/lib/layout";
import { TOC_DETAIL_CONCURRENCY, pendingChapters, runLimited } from "@/lib/ai/toc-steps";

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
  /** 세부 설계(설계 근거·절 요지)가 남은 장 번호 — 골격만 만든 상태 */
  detailPending?: number[];
};

type Chapter = Report["chapters"][number];
const newRunId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export default function TocDesign() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const sp = useSearchParams();
  const [reports, setReports] = useState<Report[] | null>(null);
  const [cur, setCur] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  /** 지금 하는 단계 — 안내 문구용 (skeleton: 골격, detail: 장별 세부) */
  const [phase, setPhase] = useState<"skeleton" | "detail" | "one" | "watch" | null>(null);
  const [since, setSince] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState<{ msg: string; raw?: string } | null>(null);
  const [project, setProject] = useState<any>(null);
  const started = useRef(false);
  const reportsRef = useRef<Report[] | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  reportsRef.current = reports;

  type Running = { startedAt: string; label: string };

  /**
   * 서버에서 이미 설계 중이면(다른 탭·화면을 떠났다 돌아옴) 새로 시작하지 않고 끝날 때까지 기다린다.
   * 5초마다 설계 중 표시를 확인하고, 끝나면 보고서 목록을 다시 읽는다.
   */
  function watch(run: Running) {
    const before = reportsRef.current?.length ?? 0;
    setPhase("watch");
    setBusy(run.label || "목차 설계 중");
    setSince(Date.parse(run.startedAt) || Date.now());
    setErr(null);
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const st = await api<{ running: Running | null }>(`/api/projects/${id}/toc/design`);
        if (st.running) return;
        if (poll.current) clearInterval(poll.current);
        poll.current = null;
        const r = await api<Report[]>(`/api/projects/${id}/toc/reports`);
        setReports(r);
        reportsRef.current = r;
        setCur(0);
        setBusy(null);
        setPhase(null);
        // 다른 탭의 설계가 장별 세부를 다 채우지 못하고 끝났으면 여기서 이어서 채운다
        if (r[0] && pendingChapters(r[0]).length) void continueDetails(r[0]);
        else if (r.length <= before) setErr({ msg: "목차 설계가 끝났지만 새 안이 만들어지지 않았습니다(실패했거나 중단됨). 다시 시도하세요." });
      } catch {
        // 잠깐의 연결 오류는 다음 확인 때 다시 본다
      }
    }, 5000);
  }

  useEffect(() => () => {
    if (poll.current) clearInterval(poll.current);
  }, []);

  useEffect(() => {
    api(`/api/projects/${id}`).then(setProject);
    Promise.all([api<Report[]>(`/api/projects/${id}/toc/reports`), api<{ running: Running | null }>(`/api/projects/${id}/toc/design`).catch(() => ({ running: null }))]).then(([r, st]) => {
      setReports(r);
      reportsRef.current = r;
      if (st.running) {
        started.current = true;
        watch(st.running);
        return;
      }
      // 골격만 만들고 멈춘 최신안 — 남은 장의 세부 설계를 이어서 채운다
      if (r[0] && pendingChapters(r[0]).length && !started.current) {
        started.current = true;
        void continueDetails(r[0]);
        return;
      }
      if (!r.length && sp.get("auto") === "1" && !started.current) {
        started.current = true;
        design({});
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!busy) return;
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - since) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [busy, since]);

  type DesignReply = { report?: Report; error?: string; raw?: string; running?: Running };
  type DetailReply = { chapter?: Chapter; detailPending?: number[]; error?: string; running?: Running };
  const designUrl = `/api/projects/${id}/toc/design`;

  /** 보고서 목록에서 한 보고서만 고친다 */
  function patchReport(reportId: string, fn: (r: Report) => Report) {
    setReports((rs) => (rs ? rs.map((r) => (r.id === reportId ? fn(r) : r)) : rs));
  }

  /**
   * 장별 세부 설계 — 장마다 요청 하나(각각 서버 시간 한도 안), 동시에 TOC_DETAIL_CONCURRENCY개.
   * 실패한 장은 한 번 더 시도하고, 그래도 안 되면 비워 둔다(화면을 다시 열면 이어서 채우거나 [이 장만 다시]로 다시 설계할 수 있다).
   */
  async function fillDetails(rep: Report, runId: string): Promise<"done" | "watching"> {
    const todo = pendingChapters(rep);
    const total = rep.chapters.length;
    let done = total - todo.length;
    const failed: number[] = [];
    let other: Running | null = null;
    setPhase("detail");
    setBusy(`장별 세부 설계 중 (${done}/${total}장)`);
    await runLimited(
      todo,
      TOC_DETAIL_CONCURRENCY,
      async (n) => {
        for (let attempt = 0; attempt < 2 && !other; attempt++) {
          try {
            const r = await api<DetailReply>(designUrl, { method: "POST", json: { step: "detail", runId, reportId: rep.id, chapterIndex: n } });
            if (r.running) {
              other = r.running;
              return;
            }
            if (r.chapter) {
              const ch = r.chapter;
              patchReport(rep.id, (x) => ({ ...x, chapters: x.chapters.map((c, i) => (i === n - 1 ? ch : c)), detailPending: (x.detailPending ?? []).filter((k) => k !== n) }));
              done++;
              setBusy(`장별 세부 설계 중 (${done}/${total}장)`);
              return;
            }
          } catch {
            // 한 번 더 시도한다
          }
        }
        if (!other) failed.push(n);
      },
      () => Boolean(other),
    );
    if (other) {
      // 다른 탭이 설계를 넘겨받았다 — 그 결과를 기다린다
      watch(other);
      return "watching";
    }
    if (failed.length) {
      failed.sort((a, b) => a - b);
      setErr({ msg: `${failed.join(", ")}장은 세부 설계(설계 근거·절 요지)를 채우지 못했습니다. 화면을 다시 열면 이어서 채우고, [이 장만 다시]로 다시 설계할 수도 있습니다.` });
    }
    return "done";
  }

  /** 골격만 저장된 보고서의 남은 장을 채운다 (화면을 떠났다 돌아온 경우) */
  async function continueDetails(rep: Report) {
    const runId = newRunId();
    setSince(Date.now());
    setErr(null);
    let waiting = false;
    try {
      waiting = (await fillDetails(rep, runId)) === "watching";
    } finally {
      if (!waiting) {
        await api(designUrl, { method: "POST", json: { step: "finish", runId } }).catch(() => {});
        setBusy(null);
        setPhase(null);
      }
    }
  }

  /** 새 목차 설계: 골격(요청 하나) → 장별 세부(장마다 요청 하나) */
  async function design(body: { regenerate?: boolean }) {
    const runId = newRunId();
    setPhase("skeleton");
    setBusy(body.regenerate ? "다른 구성으로 골격 잡는 중" : "목차 골격 잡는 중");
    setSince(Date.now());
    setErr(null);
    let waiting = false;
    let holding = false;
    try {
      const r = await api<DesignReply>(designUrl, { method: "POST", json: { step: "skeleton", runId, regenerate: body.regenerate } });
      if (r.running) {
        // 이미 서버에서 설계 중 — 그 결과를 기다린다
        waiting = true;
        watch(r.running);
      } else if (r.error) setErr({ msg: r.error, raw: r.raw });
      else if (r.report) {
        holding = true;
        setReports((rs) => [r.report!, ...(rs ?? [])]);
        setCur(0);
        waiting = (await fillDetails(r.report, runId)) === "watching";
      }
    } catch (e: any) {
      setErr({ msg: e.message });
    } finally {
      if (holding && !waiting) await api(designUrl, { method: "POST", json: { step: "finish", runId } }).catch(() => {});
      if (!waiting) {
        setBusy(null);
        setPhase(null);
      }
    }
  }

  /** [이 장만 다시] — 요청 하나로 그 장을 새로 설계해 새 안으로 저장 */
  async function redesignChapter(chapterIndex: number, baseReportId: string) {
    setPhase("one");
    setBusy(`${chapterIndex}장 다시 설계 중`);
    setSince(Date.now());
    setErr(null);
    let waiting = false;
    try {
      const r = await api<DesignReply>(designUrl, { method: "POST", json: { chapterIndex, baseReportId } });
      if (r.running) {
        waiting = true;
        watch(r.running);
      } else if (r.error) setErr({ msg: r.error, raw: r.raw });
      else if (r.report) {
        setReports((rs) => [r.report!, ...(rs ?? [])]);
        setCur(0);
      }
    } catch (e: any) {
      setErr({ msg: e.message });
    } finally {
      if (!waiting) {
        setBusy(null);
        setPhase(null);
      }
    }
  }

  async function apply(rep: Report) {
    setErr(null);
    try {
      const r = await api<{ needConfirm?: boolean; written?: number }>(`/api/projects/${id}/toc/apply`, { method: "POST", json: { reportId: rep.id } });
      if (r.needConfirm) {
        const msg = `본문이나 스케치가 있는 절이 ${r.written}개 있습니다. 목차를 교체하면 기존 장·절은 목차 아래 [삭제한 장·절]로 옮겨지고, 30일 안에 되돌릴 수 있습니다. 계속할까요?`;
        if (!(await confirmDialog(msg, { danger: true, okLabel: "목차 교체" }))) return;
        await api(`/api/projects/${id}/toc/apply`, { method: "POST", json: { reportId: rep.id, force: true } });
      }
      router.push(`/projects/${id}`);
    } catch (e: any) {
      setErr({ msg: `목차를 적용하지 못했습니다. ${e?.message ?? ""}`.trim() });
    }
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
            <div className="text-sm text-stone-500">
              {phase === "skeleton"
                ? "먼저 전체 골격(장·절 제목과 분량)을 잡습니다. 1~2분 걸립니다. 골격이 나오면 장마다 요지와 설계 근거를 채웁니다."
                : phase === "detail"
                  ? "골격은 저장됐습니다. 장마다 절 요지·흥미 포인트·설계 근거를 채우고 있습니다. 화면을 떠나면 멈추고, 다시 열면 남은 장부터 이어서 채웁니다."
                  : phase === "one"
                    ? "이 장을 새로 설계하고 있습니다. 1~2분 걸립니다."
                    : "다른 화면에서 설계하고 있습니다. 끝나면 결과가 여기에 보입니다."}
            </div>
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
                        {ci + 1}장 {stripChapterNo(c.title)}
                      </div>
                      {c.promise && <div className="text-sm text-stone-600">→ {c.promise}</div>}
                      {rep.detailPending?.includes(ci + 1) && <div className="text-xs text-stone-400">{busy ? "절 요지·설계 근거 채우는 중…" : "절 요지·설계 근거를 아직 채우지 못했습니다"}</div>}
                    </div>
                    <button className="btn-ghost shrink-0 text-xs" disabled={!!busy} onClick={() => redesignChapter(ci + 1, rep.id)}>
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
