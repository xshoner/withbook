"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { attachFile } from "@/lib/upload-client";
import { toastError } from "@/components/ui/feedback";

type Kind = "h1" | "h2" | "h3" | "jang" | "part" | "dec" | "num";
type Pick = Kind | "auto" | "none";
type Preview = {
  token: string;
  fileName: string;
  title: string;
  detected: { chapter: Kind | "none"; section: Kind | "none" };
  candidates: { kind: Kind; label: string; count: number }[];
  chapters: { title: string; kind: "front" | "body" | "back"; sections: { title: string; chars: number; preview: string }[] }[];
  totalChars: number;
  warnings: string[];
};

const KIND_LABEL = { front: "앞붙이", body: "", back: "뒷붙이" } as const;

/** 기존 원고 가져오기 — 파일을 올리면 장·절 구조를 먼저 보여 주고, 확인하면 새 책으로 만든다 */
export default function ImportManuscript() {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [p, setP] = useState<Preview | null>(null);
  const [chapter, setChapter] = useState<Pick>("auto");
  const [section, setSection] = useState<Pick>("auto");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");

  const upload = async (f: File) => {
    setBusy("원고를 읽고 장·절을 찾는 중… (큰 파일은 1분 안팎)");
    try {
      const fd = new FormData();
      await attachFile(fd, "file", f);
      const r = await api<Preview>("/api/projects/import-manuscript", { method: "POST", body: fd });
      setP(r);
      setTitle(r.title);
      setChapter("auto");
      setSection("auto");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  };

  const resplit = async (c: Pick, s: Pick) => {
    if (!p) return;
    setChapter(c);
    setSection(s);
    setBusy("다시 나누는 중…");
    try {
      setP(await api<Preview>("/api/projects/import-manuscript", { method: "POST", json: { token: p.token, chapter: c, section: s } }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy("");
    }
  };

  const confirm = async () => {
    if (!p || !title.trim()) return;
    setBusy("책을 만드는 중…");
    try {
      const r = await api<{ id: string }>("/api/projects/import-manuscript", { method: "POST", json: { token: p.token, confirm: true, title, author, chapter, section } });
      router.push(`/projects/${r.id}`);
    } catch (e) {
      toastError(e);
      setBusy("");
    }
  };

  const sections = p?.chapters.reduce((a, c) => a + c.sections.length, 0) ?? 0;
  const select = (label: string, value: Pick, onChange: (v: Pick) => void, detected: Kind | "none") => (
    <label className="flex items-center gap-2 text-sm">
      <span className="shrink-0 text-stone-600">{label}</span>
      <select className="input w-auto py-1" value={value} disabled={!!busy} onChange={(e) => onChange(e.target.value as Pick)}>
        <option value="auto">자동{detected !== "none" ? ` (${p?.candidates.find((c) => c.kind === detected)?.label ?? detected})` : " (찾지 못함)"}</option>
        {p?.candidates.map((c) => (
          <option key={c.kind} value={c.kind}>
            {c.label} — {c.count}곳
          </option>
        ))}
        <option value="none">나누지 않음</option>
      </select>
    </label>
  );

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <Link href="/projects" className="btn-ghost mb-4">
        ← 책 목록
      </Link>
      <h1 className="font-bookhead text-2xl">원고 가져오기</h1>
      <p className="mb-6 mt-1 text-sm text-stone-500">
        이미 써 둔 원고(docx·hwpx·pdf·txt·md)를 새 책으로 가져옵니다. 제목 줄(워드 제목 스타일, “제1장”, “1.1” 등)로 장·절을 나누고, 만들기 전에 나눈 결과를 먼저 보여 드립니다. 그림·표 서식은 가져오지 않고 글만 가져옵니다.
      </p>

      <div className="card space-y-3 p-6">
        <div className="flex flex-wrap items-center gap-3 rounded-lg border-2 border-dashed border-stone-300 bg-stone-50 px-4 py-3">
          <input
            id="ms-file"
            type="file"
            accept=".docx,.hwpx,.pdf,.txt,.md"
            className="sr-only"
            disabled={!!busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) upload(f);
            }}
          />
          <label htmlFor="ms-file" className={`btn-primary cursor-pointer ${busy ? "pointer-events-none opacity-50" : ""}`}>
            📁 원고 파일 고르기
          </label>
          <span className="min-w-0 flex-1 truncate text-sm text-stone-600">{busy || (p ? `「${p.fileName}」 — ${p.totalChars.toLocaleString()}자` : "docx · hwpx · pdf · txt · md, 50MB까지")}</span>
        </div>
        <p className="text-xs text-stone-400">PDF는 줄바꿈을 문장 단위로 다시 잇고 쪽 번호·머리글을 뺍니다. 스캔한 PDF(글자가 그림인 파일)는 읽을 수 없습니다.</p>
      </div>

      {p && (
        <>
          <div className="card mt-6 space-y-4 p-6">
            <h2 className="font-semibold">나눈 결과 확인</h2>
            <div className="flex flex-wrap gap-4">
              {select("장 기준", chapter, (v) => resplit(v, section), p.detected.chapter)}
              {select("절 기준", section, (v) => resplit(chapter, v), p.detected.section)}
            </div>
            {p.warnings.length > 0 && (
              <ul className="space-y-1 rounded bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {p.warnings.map((w, i) => (
                  <li key={i}>⚠ {w}</li>
                ))}
              </ul>
            )}
            <p className="text-sm text-stone-600">
              장 {p.chapters.length}개 · 절 {sections}개 · 모두 {p.totalChars.toLocaleString()}자 (약 {Math.round(p.totalChars / 700).toLocaleString()}쪽)
            </p>
            <ol className="max-h-[50vh] space-y-2 overflow-auto rounded border border-stone-200 p-3 text-sm">
              {p.chapters.map((c, ci) => (
                <li key={ci}>
                  <div className="font-semibold text-stone-800">
                    {KIND_LABEL[c.kind] && <span className="mr-1 rounded bg-stone-100 px-1 text-[11px] font-normal text-stone-500">{KIND_LABEL[c.kind]}</span>}
                    {c.title}
                  </div>
                  <ul className="ml-4 mt-0.5 divide-y divide-stone-100">
                    {c.sections.map((s, si) => (
                      <li key={si} className="flex items-baseline gap-2 py-0.5 text-xs">
                        <span className="shrink-0 text-stone-700">{s.title}</span>
                        <span className="min-w-0 flex-1 truncate text-stone-400">{s.preview}</span>
                        <span className={`shrink-0 ${s.chars > 40000 ? "text-amber-700" : "text-stone-400"}`}>{s.chars.toLocaleString()}자</span>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
            <p className="text-xs text-stone-500">장 번호(1장, 2장…)는 앱이 붙이므로 원고의 “제1장” 같은 번호는 제목에서 뺐습니다. 가져온 뒤 목차에서 장·절을 옮기거나 합치고 이름을 바꿀 수 있습니다.</p>
          </div>

          <div className="card mt-6 space-y-3 p-6">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="label">책 제목</label>
                <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div>
                <label className="label">지은이 (선택)</label>
                <input className="input" value={author} onChange={(e) => setAuthor(e.target.value)} />
              </div>
            </div>
            <p className="text-xs text-stone-500">새 책에는 설정의 기본 문체가 적용되고, 가져온 절은 ‘편집 중’ 상태가 됩니다. 주제·대상 독자 같은 책 정보는 [책 설정]에서 채우세요 — AI 집필·교정·베타 리더가 참고합니다.</p>
            <button className="btn-accent w-full" disabled={!!busy || !title.trim()} onClick={confirm}>
              {busy === "책을 만드는 중…" ? busy : `이 구조로 새 책 만들기 (장 ${p.chapters.length} · 절 ${sections})`}
            </button>
          </div>
        </>
      )}
    </main>
  );
}
