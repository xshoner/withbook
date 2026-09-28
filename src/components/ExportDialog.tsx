"use client";

import { useEffect, useState } from "react";
import { api, download } from "@/lib/client";

type Issue = { level: "error" | "warn" | "info"; message: string; where?: string };
type SubmitItem = { id: string; label: string; status: "pass" | "warn" | "fail"; detail: string; fix?: { label: string; href?: string; action?: "pdf" | "checks" | "cover" | "settings" } };
type Layout = { margins: { inner: number; outer: number; top: number; bottom: number; header: number; footer: number }; bodySizePt: number; lineHeight: number; paraSpacingMm: number };
const STATUS = { pass: ["✓", "text-emerald-700", "통과"], warn: ["⚠", "text-amber-700", "주의"], fail: ["⛔", "text-red-700", "문제"] } as const;

export default function ExportDialog({
  projectId,
  title,
  chapterId,
  sectionId,
  onClose,
  onOpenChecks,
}: {
  projectId: string;
  title: string;
  chapterId?: string;
  sectionId?: string;
  onClose: () => void;
  /** 제출 전 점검의 [확인할 것 열기] — 편집 화면의 확인할 것(ChecksDialog)을 연다. 없으면 안내 문구만 */
  onOpenChecks?: () => void;
}) {
  const [tab, setTab] = useState<"submit" | "pdf" | "hwpx" | "backup">("pdf");
  const [submit, setSubmit] = useState<{ items: SubmitItem[]; counts: Record<SubmitItem["status"], number> } | null>(null);
  const [submitErr, setSubmitErr] = useState("");
  const [layout, setLayout] = useState<Layout | null>(null);
  const [size, setSize] = useState<"bleed" | "trim">("bleed");
  const [scope, setScope] = useState<"all" | "chapter" | "section">("all");
  const [padEven, setPadEven] = useState(true);
  const [withVersions, setWithVersions] = useState(false);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState("");
  const [backupNote, setBackupNote] = useState("");
  /** 백업 — 만든 뒤 크기·빠진 이미지·복원 한도를 알리고 내려받는다 */
  const makeBackup = async () => {
    setBusy("백업 만드는 중…");
    setErr("");
    setBackupNote("");
    try {
      const res = await fetch(`/api/projects/${projectId}/backup?json=1${withVersions ? "&versions=all" : ""}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `백업 실패 (${res.status})`);
      const a = document.createElement("a");
      if ((res.headers.get("content-type") ?? "").includes("application/json")) {
        const j = await res.json();
        a.href = j.download;
        a.download = j.filename ?? "backup.zip";
        const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
        const notes = [`백업 ${mb(j.size)}을 내려받았습니다.`];
        if (j.missingImages) notes.push(`저장소에서 찾지 못한 이미지 ${j.missingImages}개는 빠졌습니다.`);
        if (j.overImportLimit) notes.push(`[백업 불러오기] 한도(${mb(j.importLimit)})보다 커서 이 파일로는 복원할 수 없습니다.${withVersions ? " 버전 기록을 빼고 한 번 더 받아 두세요." : " 이미지가 많은 책입니다 — 파일은 보관용으로 두세요."}`);
        setBackupNote(notes.join(" "));
      } else {
        a.href = URL.createObjectURL(await res.blob()); // 로컬 실행: 파일을 바로 받는다
        a.download = "backup.zip";
      }
      a.click();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    setIssues(null);
    api<{ issues: Issue[] }>(`/api/projects/${projectId}/preflight?size=${size}`).then((r) => setIssues(r.issues));
  }, [projectId, size]);

  const errors = issues?.filter((i) => i.level === "error") ?? [];

  const loadSubmit = () => {
    setSubmitErr("");
    setSubmit(null);
    api<{ items: SubmitItem[]; counts: Record<SubmitItem["status"], number> }>(`/api/projects/${projectId}/submission-check`).then(setSubmit, (e) => setSubmitErr(e.message));
  };
  useEffect(() => {
    if (tab === "submit" && !submit && !submitErr) loadSubmit();
    if (tab === "hwpx" && !layout) api<{ layout: Layout }>(`/api/projects/${projectId}`).then((p) => setLayout(p.layout), () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const fix = (f: NonNullable<SubmitItem["fix"]>) => {
    if (f.action === "pdf") return setTab("pdf");
    if (f.action === "checks" && onOpenChecks) {
      onClose();
      return onOpenChecks();
    }
    if (f.href) window.open(f.href, "_blank", "noopener");
  };

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
      if (scope === "all") setSubmit(null); // 제출 전 점검을 다시 열면 새 PDF 결과로 본다
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
              ["submit", "제출 전 점검"],
              ["pdf", "PDF (인쇄 제출용)"],
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
          {tab === "submit" && (
            <>
              <p className="text-xs text-stone-500">
                인쇄소에 올리기 전에 본문 PDF와 표지를 한 화면에서 확인합니다. 본문 판형·글꼴·쪽수는 마지막으로 만든 <b>책 전체 PDF</b> 기준입니다.
              </p>
              {submitErr && <p className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">{submitErr}</p>}
              {!submit && !submitErr && <p className="text-xs text-stone-400">점검 중…</p>}
              {submit && (
                <>
                  <div className={`rounded px-3 py-2 text-xs font-semibold ${submit.counts.fail ? "bg-red-50 text-red-800" : submit.counts.warn ? "bg-amber-50 text-amber-900" : "bg-emerald-50 text-emerald-800"}`}>
                    {submit.counts.fail ? `고쳐야 할 문제 ${submit.counts.fail}건` : submit.counts.warn ? "제출할 수 있지만 확인할 것이 있습니다" : "제출 준비가 끝났습니다"} · 통과 {submit.counts.pass} · 주의 {submit.counts.warn} · 문제 {submit.counts.fail}
                  </div>
                  <ul className="max-h-[52vh] divide-y divide-stone-100 overflow-auto rounded border border-stone-200">
                    {submit.items.map((it) => (
                      <li key={it.id} className="flex items-start gap-2 px-3 py-2 text-xs leading-5">
                        <span className={`w-4 shrink-0 text-center ${STATUS[it.status][1]}`} title={STATUS[it.status][2]}>
                          {STATUS[it.status][0]}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="font-semibold text-stone-800">{it.label}</div>
                          <div className="text-stone-600">{it.detail}</div>
                        </div>
                        {it.fix && (it.fix.action !== "checks" || onOpenChecks) && (
                          <button className="btn-ghost shrink-0 text-xs text-amber-800" onClick={() => fix(it.fix!)}>
                            {it.fix.label} →
                          </button>
                        )}
                        {it.fix?.action === "checks" && !onOpenChecks && <span className="shrink-0 text-[11px] text-stone-400">편집 화면 [확인할 것]</span>}
                      </li>
                    ))}
                  </ul>
                  <div className="flex items-center gap-2">
                    <button className="btn-ghost text-xs" onClick={loadSubmit}>
                      ↻ 다시 점검
                    </button>
                    <span className="text-[11px] text-stone-400">ISBN 바코드는 인쇄소가 뒷표지에 넣습니다 — 표지 편집기의 [바코드 자리] 안내선을 켜고 글·사진이 겹치지 않게 두세요.</span>
                  </div>
                </>
              )}
            </>
          )}
          {tab === "pdf" && (
            <>
              <div>
                <div className="label">판형</div>
                <label className="flex items-start gap-2 py-1">
                  <input type="radio" className="mt-1" checked={size === "bleed"} onChange={() => setSize("bleed")} />
                  <span>
                    <b>154×216mm</b> — 재단 여백(사방 3mm) 포함 <span className="text-amber-700">권장</span>
                    <span className="block text-xs text-stone-500">인쇄소가 사방 3mm를 잘라 148×210mm(A5)로 제작합니다. 원고가 확대되지 않습니다.</span>
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
                한글(한컴오피스)에서 열 수 있는 HWPX로 내보냅니다. 용지 154×216mm, 맞쪽
                {layout ? (
                  <>
                    , 여백 안쪽 {layout.margins.inner} · 바깥 {layout.margins.outer} · 위 {layout.margins.top} · 아래 {layout.margins.bottom}, 머리말 {layout.margins.header} · 꼬리말 {layout.margins.footer}mm, 본문 KoPub바탕체 Light {layout.bodySizePt}pt / 줄 간격 {Math.round(layout.lineHeight * 100)}%
                    {layout.paraSpacingMm ? ` / 문단 간격 ${layout.paraSpacingMm}mm` : ""} — 이 책의 [책 설정 → 조판] 값 그대로입니다.
                  </>
                ) : (
                  <>, 여백·글자 크기·줄 간격은 이 책의 [책 설정 → 조판] 값을 따릅니다.</>
                )}
              </p>
              <p className="rounded bg-stone-50 p-2 text-xs text-stone-500">쪽 나눔은 한글이 다시 계산하므로 PDF와 쪽수가 조금 다를 수 있습니다. 인쇄 제출은 PDF를 권장합니다.</p>
              <button className="btn-accent w-full" disabled={!!busy} onClick={makeHwpx}>
                {busy ?? "HWPX 다운로드"}
              </button>
            </>
          )}
          {tab === "backup" && (
            <>
              <p className="text-stone-600">책 전체(책 정보·목차·본문·이미지·표지 디자인·책 기억·절 참고 자료·고친 개요)를 zip 하나로 내려받습니다. 책 목록의 [백업 불러오기]로 복원할 수 있습니다(50MB까지). AI 설정·API 키는 담지 않습니다.</p>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={withVersions} onChange={(e) => setWithVersions(e.target.checked)} /> 버전 기록 포함
              </label>
              <p className="text-xs text-stone-500">기본은 버전 기록을 빼고 현재 원고와 이미지만 담습니다(가볍고 빠름). 절마다 쌓인 이전 원고까지 보관하려면 켜세요 — 백업이 커지고 오래 걸릴 수 있습니다.</p>
              <button className="btn-accent w-full" disabled={!!busy} onClick={makeBackup}>
                {busy ?? "백업 zip 다운로드"}
              </button>
              {backupNote && <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">{backupNote}</p>}
            </>
          )}
          {err && <p className="whitespace-pre-wrap rounded bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}
        </div>
      </div>
    </div>
  );
}
