"use client";

import { useEffect, useState } from "react";
import { api, download } from "@/lib/client";

type Issue = { level: "error" | "warn" | "info"; message: string; where?: string };

export default function ExportDialog({
  projectId,
  title,
  chapterId,
  sectionId,
  onClose,
}: {
  projectId: string;
  title: string;
  chapterId?: string;
  sectionId?: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"pdf" | "hwpx" | "backup">("pdf");
  const [size, setSize] = useState<"bleed" | "trim">("bleed");
  const [scope, setScope] = useState<"all" | "chapter" | "section">("all");
  const [padEven, setPadEven] = useState(true);
  const [withVersions, setWithVersions] = useState(true);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    setIssues(null);
    api<{ issues: Issue[] }>(`/api/projects/${projectId}/preflight?size=${size}`).then((r) => setIssues(r.issues));
  }, [projectId, size]);

  const errors = issues?.filter((i) => i.level === "error") ?? [];

  const makePdf = async () => {
    setBusy("PDF 조판·인쇄 중… (책 분량에 따라 수십 초)");
    setErr("");
    setResult(null);
    try {
      const h = await download(
        `/api/projects/${projectId}/export/pdf`,
        { size, scope, targetId: scope === "chapter" ? chapterId : scope === "section" ? sectionId : undefined, padEven },
        `${title}.pdf`,
      );
      const c = h.get("x-pdf-check");
      if (c) setResult(JSON.parse(decodeURIComponent(c)));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };
  const makeHwpx = async () => {
    setBusy("HWPX 만드는 중…");
    setErr("");
    try {
      await download(`/api/projects/${projectId}/export/hwpx`, {}, `${title}.hwpx`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="card w-[560px] max-w-[95vw] p-0" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-3">
          <h2 className="font-bookhead text-lg">내보내기</h2>
          <button className="btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="flex border-b border-stone-200 px-5 text-sm">
          {(
            [
              ["pdf", "PDF (부크크 제출용)"],
              ["hwpx", "HWPX (한글)"],
              ["backup", "백업"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={`-mb-px mr-4 border-b-2 py-2 ${tab === k ? "border-amber-700 font-semibold" : "border-transparent text-stone-500"}`}>
              {l}
            </button>
          ))}
        </div>
        <div className="space-y-4 p-5 text-sm">
          {tab === "pdf" && (
            <>
              <div>
                <div className="label">판형</div>
                <label className="flex items-start gap-2 py-1">
                  <input type="radio" className="mt-1" checked={size === "bleed"} onChange={() => setSize("bleed")} />
                  <span>
                    <b>154×216mm</b> — 재단 여백(사방 3mm) 포함 <span className="text-amber-700">권장</span>
                    <span className="block text-xs text-stone-500">부크크가 사방 3mm를 잘라 148×210mm(A5)로 제작합니다. 원고가 확대되지 않습니다.</span>
                  </span>
                </label>
                <label className="flex items-start gap-2 py-1">
                  <input type="radio" className="mt-1" checked={size === "trim"} onChange={() => setSize("trim")} />
                  <span>
                    <b>148×210mm</b> — 정사이즈
                    <span className="block text-xs text-stone-500">풀블리드 이미지가 없을 때만 가능. 여백은 3mm씩 줄여 같은 본문 위치를 유지합니다.</span>
                  </span>
                </label>
              </div>
              <div className="flex gap-6">
                <div>
                  <div className="label">범위</div>
                  <select className="input w-40" value={scope} onChange={(e) => setScope(e.target.value as any)}>
                    <option value="all">책 전체</option>
                    <option value="chapter" disabled={!chapterId}>
                      현재 장
                    </option>
                    <option value="section" disabled={!sectionId}>
                      현재 절
                    </option>
                  </select>
                </div>
                <label className="mt-6 flex items-center gap-2">
                  <input type="checkbox" checked={padEven} onChange={(e) => setPadEven(e.target.checked)} /> 총 페이지 짝수로 맞추기
                </label>
              </div>
              <div>
                <div className="label">사전 점검</div>
                {!issues ? (
                  <p className="text-xs text-stone-400">점검 중…</p>
                ) : issues.length === 0 ? (
                  <p className="rounded bg-emerald-50 px-3 py-2 text-xs text-emerald-700">문제 없음 — 출력할 수 있습니다.</p>
                ) : (
                  <ul className="max-h-44 space-y-1 overflow-auto rounded border border-stone-200 p-2 text-xs">
                    {issues.map((i, k) => (
                      <li key={k} className={i.level === "error" ? "text-red-700" : i.level === "warn" ? "text-amber-800" : "text-stone-500"}>
                        {i.level === "error" ? "⛔" : i.level === "warn" ? "⚠" : "ℹ"} {i.message}
                        {i.where && <span className="text-stone-400"> — {i.where}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button className="btn-accent w-full" disabled={!!busy || errors.length > 0 || !issues} onClick={makePdf}>
                {busy ?? "PDF 만들기"}
              </button>
              {result && (
                <div className={`rounded px-3 py-2 text-xs ${result.sizeOk && result.kopubEmbedded ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>
                  출력 확인: {result.widthMm}×{result.heightMm}mm {result.sizeOk ? "✓ 판형 일치" : "✗ 판형 불일치"} · {result.pages}쪽 · 글꼴 임베딩{" "}
                  {result.kopubEmbedded ? "✓ KoPub 포함" : "✗ KoPub 없음"}
                  <div className="mt-0.5 text-stone-500">{result.fontsEmbedded?.join(", ")}</div>
                </div>
              )}
            </>
          )}
          {tab === "hwpx" && (
            <>
              <p className="text-stone-600">
                한글(한컴오피스)에서 열 수 있는 HWPX로 내보냅니다. 용지 154×216mm, 맞쪽, 여백 안쪽 28 · 바깥 23 · 위 18 · 아래 18, 머리말 7 · 꼬리말 13mm, 본문 KoPub바탕체 Light 10pt / 줄 간격 160%로 부크크 기본 서식과 같습니다.
              </p>
              <p className="rounded bg-stone-50 p-2 text-xs text-stone-500">쪽 나눔은 한글이 다시 계산하므로 PDF와 쪽수가 조금 다를 수 있습니다. 부크크 제출은 PDF를 권장합니다.</p>
              <button className="btn-accent w-full" disabled={!!busy} onClick={makeHwpx}>
                {busy ?? "HWPX 다운로드"}
              </button>
            </>
          )}
          {tab === "backup" && (
            <>
              <p className="text-stone-600">프로젝트 전체(책 정보·목차·본문·버전 기록·이미지)를 zip 하나로 내려받습니다. 프로젝트 목록의 [백업 불러오기]로 복원할 수 있습니다.</p>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={withVersions} onChange={(e) => setWithVersions(e.target.checked)} /> 버전 기록 포함
              </label>
              <p className="text-xs text-stone-500">버전 기록을 빼면 백업이 가볍고 빨라집니다. 현재 원고와 이미지는 그대로 담깁니다.</p>
              <a className="btn-accent w-full" href={`/api/projects/${projectId}/backup${withVersions ? "" : "?versions=none"}`}>
                백업 zip 다운로드
              </a>
            </>
          )}
          {err && <p className="whitespace-pre-wrap rounded bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}
        </div>
      </div>
    </div>
  );
}
