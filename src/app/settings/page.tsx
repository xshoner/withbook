"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AiSettingsPanel from "@/components/AiSettingsPanel";
import StyleProfileView from "@/components/StyleProfileView";
import { api, fmtDate } from "@/lib/client";
import { attachFile } from "@/lib/upload-client";
import { confirmDialog, toast, toastError } from "@/components/ui/feedback";

export default function Settings() {
  const [cfg, setCfg] = useState<any>(null);
  const [test, setTest] = useState<any>(null);
  const [usage, setUsage] = useState<any>(null);
  const [ins, setIns] = useState<{ path: string; text: string; history: string[] } | null>(null);
  const [insText, setInsText] = useState("");
  const [style, setStyle] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");

  const loadStyle = () => api("/api/style/global").then(setStyle);
  useEffect(() => {
    api("/api/ai/status").then(setCfg);
    api("/api/ai/usage").then(setUsage);
    api("/api/instruction").then((r) => {
      setIns(r);
      setInsText(r.text);
    });
    loadStyle();
  }, []);

  const PURPOSE: Record<string, string> = {
    toc_design: "목차 설계",
    section_write: "집필",
    section_write_part: "집필(분할)",
    section_outline: "긴 절 개요",
    summary: "절 요약",
    chapter_summary: "장 요약",
    proofread: "교정·교열",
    length_adjust: "분량 조정",
    style_analyze: "문체 분석",
    ping: "연결 확인",
  };

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <Link href="/projects" className="btn-ghost">
        ← 프로젝트 목록
      </Link>
      <h1 className="font-bookhead text-2xl">설정</h1>
      {msg && <p className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{msg}</p>}

      <section className="card p-6">
        <h2 className="mb-3 font-semibold">AI 연결</h2>
        <AiSettingsPanel />
      </section>

      <section id="style" className="card p-6">
        <h2 className="mb-1 font-semibold">작가 문체 학습 (style reference)</h2>
        <p className="mb-3 text-sm text-stone-500">
          보관 위치: <code className="text-xs">{style?.dir}</code> — 새 프로젝트를 만들면 이 프로필이 자동 적용됩니다. 글을 더 올리고 [다시 학습]을 누르면 기존 자료와 합쳐 추가 학습합니다.
        </p>
        <ul className="mb-3 divide-y divide-stone-100 rounded border border-stone-200 text-sm text-stone-600">
          {style?.files.map((f: any) => (
            <li key={f.name} className="flex items-center gap-2 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="text-xs text-stone-400">{Math.round(f.size / 1024).toLocaleString()}KB</span>
              <button
                className="text-xs text-red-600 hover:underline"
                disabled={!!busy}
                onClick={async () => {
                  if (!(await confirmDialog(`학습 자료에서 「${f.name}」을(를) 뺄까요? (이미 학습된 프로필은 다시 학습할 때 바뀝니다)`, { okLabel: "빼기" }))) return;
                  await api(`/api/style/global?name=${encodeURIComponent(f.name)}`, { method: "DELETE" });
                  await loadStyle();
                }}
              >
                빼기
              </button>
            </li>
          ))}
          {!style?.files?.length && <li className="px-3 py-2 text-stone-400">학습 자료가 없습니다.</li>}
        </ul>
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
                setMsg(`학습 자료 ${list.length}개를 올렸습니다. [다시 학습]을 누르면 반영됩니다.`);
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
              await loadStyle();
              setMsg("문체를 다시 학습했습니다.");
            } catch (e: any) {
              toastError(e);
            } finally {
              setBusy("");
            }
          }}
        >
          {busy === "style" ? "학습 중… (1~3분)" : style?.global ? "다시 학습" : "문체 학습 시작"}
        </button>
        {style?.global && (
          <div className="mt-5 border-t border-stone-100 pt-4">
            <p className="mb-3 text-xs text-stone-500">
              학습: {fmtDate(style.global.analyzedAt)} · {style.global.files.join(" / ")}
            </p>
            <StyleProfileView profile={style.global.profile} />
          </div>
        )}
      </section>

      <section className="card p-6">
        <h2 className="mb-1 font-semibold">instruction.md — 서술 기본 스타일 규칙</h2>
        <p className="mb-3 text-sm text-stone-500">
          집필·교정·부분 수정 요청마다 전문이 AI에게 전달됩니다. 저장하면 바로 반영되고, 이전 내용은 최근 20개까지 보관됩니다.
          <br />
          <code className="text-xs">{ins?.path}</code>
        </p>
        <textarea className="input min-h-[420px] font-mono text-xs leading-5" value={insText} onChange={(e) => setInsText(e.target.value)} />
        <div className="mt-2 flex items-center gap-3">
          <button
            className="btn-primary"
            disabled={insText === ins?.text}
            onClick={async () => {
              await api("/api/instruction", { method: "PUT", json: { text: insText } });
              const r = await api("/api/instruction");
              setIns(r);
              setMsg("instruction.md를 저장했습니다.");
            }}
          >
            저장
          </button>
          {ins?.history.length ? <span className="text-xs text-stone-400">이전 버전 {ins.history.length}개 보관 중</span> : null}
        </div>
      </section>

      <section className="card p-6">
        <h2 className="mb-3 font-semibold">AI 사용량</h2>
        {usage && (
          <>
            <div className="mb-4 grid grid-cols-4 gap-3 text-center text-sm">
              <div className="rounded bg-stone-50 p-3">
                <div className="text-xs text-stone-500">호출</div>
                <div className="text-lg font-semibold">{usage.sum._count}</div>
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
                <div className="text-xs text-stone-500">추정 비용(게이트웨이 단위)</div>
                <div className="text-lg font-semibold">{(usage.sum._sum.cost ?? 0).toFixed(2)}</div>
              </div>
            </div>
            <table className="mb-4 w-full text-sm">
              <thead className="text-left text-xs text-stone-500">
                <tr>
                  <th>용도</th>
                  <th className="text-right">호출</th>
                  <th className="text-right">입력</th>
                  <th className="text-right">출력</th>
                  <th className="text-right">비용</th>
                </tr>
              </thead>
              <tbody>
                {usage.byPurpose.map((b: any) => (
                  <tr key={b.purpose} className="border-t border-stone-100">
                    <td className="py-1">{PURPOSE[b.purpose] ?? b.purpose}</td>
                    <td className="text-right">{b._count}</td>
                    <td className="text-right">{(b._sum.promptTokens ?? 0).toLocaleString()}</td>
                    <td className="text-right">{(b._sum.completionTokens ?? 0).toLocaleString()}</td>
                    <td className="text-right">{(b._sum.cost ?? 0).toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <details>
              <summary className="cursor-pointer text-sm text-stone-600">최근 호출 50건 (instruction.md 포함 여부 확인)</summary>
              <table className="mt-2 w-full text-xs">
                <thead className="text-left text-stone-500">
                  <tr>
                    <th>시각</th>
                    <th>용도</th>
                    <th>상태</th>
                    <th className="text-right">토큰(입/출)</th>
                    <th className="text-right">시간</th>
                    <th className="text-center">instruction.md</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.recent.map((r: any) => (
                    <tr key={r.id} className="border-t border-stone-100" title={r.error ?? ""}>
                      <td className="py-1">{fmtDate(r.createdAt)}</td>
                      <td>{PURPOSE[r.purpose] ?? r.purpose}</td>
                      <td className={r.status === "ok" ? "text-emerald-700" : "text-red-600"}>{r.status}</td>
                      <td className="text-right">
                        {r.promptTokens.toLocaleString()}/{r.completionTokens.toLocaleString()}
                      </td>
                      <td className="text-right">{(r.ms / 1000).toFixed(1)}s</td>
                      <td className="text-center">{r.instructionIncluded ? "✓" : "–"}</td>
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
