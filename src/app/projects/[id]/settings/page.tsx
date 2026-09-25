"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import AiSettingsPanel from "@/components/AiSettingsPanel";
import BookInfoForm, { type BookInfo } from "@/components/BookInfoForm";
import StyleProfileView from "@/components/StyleProfileView";
import { api } from "@/lib/client";
import { attachFile } from "@/lib/upload-client";
import type { LayoutSettings } from "@/lib/layout";
import { BLEED, SAFE_MIN_FROM_TRIM } from "@/lib/print/spec";
import { toast, toastError } from "@/components/ui/feedback";

type Tab = "info" | "style" | "layout" | "glossary" | "ai";

export default function ProjectSettings() {
  const { id } = useParams<{ id: string }>();
  const [p, setP] = useState<any>(null);
  const [tab, setTab] = useState<Tab>("info");
  const [msg, setMsg] = useState("");
  const load = () => api(`/api/projects/${id}`).then(setP);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(""), 2500);
  };
  if (!p) return <div className="p-10 text-stone-400">불러오는 중…</div>;

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <Link href={`/projects/${id}`} className="btn-ghost mb-3">
        ← 집필 화면
      </Link>
      <h1 className="font-bookhead text-2xl">책 설정</h1>
      <p className="mb-4 text-sm text-stone-500">『{p.title}』</p>
      <div className="mb-6 flex gap-1 border-b border-stone-200">
        {(
          [
            ["info", "책 정보"],
            ["style", "문체"],
            ["layout", "조판 · 판권면"],
            ["glossary", "용어집"],
            ["ai", "AI 설정"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`-mb-px border-b-2 px-4 py-2 text-sm ${tab === k ? "border-amber-700 font-semibold" : "border-transparent text-stone-500"}`}>
            {l}
          </button>
        ))}
        {msg && <span className="ml-auto self-center text-xs text-emerald-700">{msg}</span>}
      </div>

      {tab === "info" && (
        <div className="card p-6">
          <BookInfoForm
            initial={p as BookInfo}
            submitLabel="저장"
            onSubmit={async (v) => {
              await api(`/api/projects/${id}`, { method: "PATCH", json: v });
              await load();
              flash("저장했습니다.");
            }}
          />
        </div>
      )}
      {tab === "style" && <StyleTab p={p} reload={load} flash={flash} />}
      {tab === "layout" && <LayoutTab p={p} reload={load} flash={flash} />}
      {tab === "glossary" && <GlossaryTab id={id} />}
      {tab === "ai" && (
        <div className="card space-y-2 p-6">
          <h2 className="font-semibold">AI 설정</h2>
          <p className="mb-2 text-sm text-stone-500">집필·교정·각주 등 모든 AI 기능이 쓰는 연결입니다. 지금 적용된 값이 표시됩니다. [수정]을 눌러 바꾸고 [확인]을 누르면 새 값으로 바로 연결을 점검합니다.</p>
          <AiSettingsPanel />
        </div>
      )}
    </main>
  );
}

function StyleTab({ p, reload, flash }: { p: any; reload: () => void; flash: (m: string) => void }) {
  const [busy, setBusy] = useState("");
  const [samples, setSamples] = useState("");
  const [useRef_, setUseRef] = useState(true);
  const files = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const profile = p.styleProfile ? JSON.parse(p.styleProfile) : null;
  const run = async (source: "global" | "analyze") => {
    setBusy(source === "global" ? "기본 프로필 적용 중…" : "문체 분석 중… (1~2분)");
    try {
      const fd = new FormData();
      fd.append("source", source);
      if (source === "analyze") {
        fd.append("useReference", useRef_ ? "1" : "0");
        fd.append("samples", samples);
        for (const f of files.current?.files ?? []) await attachFile(fd, "files", f);
      }
      await api(`/api/projects/${p.id}/style`, { method: "POST", body: fd });
      await reload();
      flash("문체 프로필을 갱신했습니다.");
    } catch (e: any) {
      toastError(e);
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="space-y-6">
      <div className="card p-6">
        <h2 className="mb-3 font-semibold">현재 문체 프로필</h2>
        {profile ? (
          <StyleProfileView
            profile={profile}
            onSave={async (np) => {
              await api(`/api/projects/${p.id}`, { method: "PATCH", json: { styleProfile: np } });
              await reload();
              flash("저장했습니다.");
            }}
          />
        ) : (
          <p className="text-sm text-stone-500">아직 문체 프로필이 없습니다. 아래에서 학습하세요.</p>
        )}
      </div>
      <EditLearnCard p={p} reload={reload} flash={flash} />
      <div className="card space-y-4 p-6">
        <h2 className="font-semibold">문체 다시 학습</h2>
        <button className="btn" disabled={!!busy} onClick={() => run("global")}>
          style reference 폴더로 학습한 기본 프로필 적용
        </button>
        <div className="border-t border-stone-100 pt-4">
          <label className="mb-2 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={useRef_} onChange={(e) => setUseRef(e.target.checked)} /> style reference 폴더 글 포함
          </label>
          <label className="label">추가 샘플 붙여넣기</label>
          <textarea className="input min-h-[120px]" value={samples} onChange={(e) => setSamples(e.target.value)} placeholder="이 책에 가까운 문체의 글을 붙여 넣으세요" />
          <label className="label mt-3">파일 업로드 (.txt .docx .hwpx .pdf)</label>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border-2 border-dashed border-stone-300 bg-stone-50 px-4 py-3">
            <input
              ref={files}
              id="style-files"
              type="file"
              multiple
              accept=".txt,.md,.docx,.hwpx,.pdf"
              className="sr-only"
              onChange={(e) => setPicked([...(e.target.files ?? [])].map((f) => f.name))}
            />
            <label htmlFor="style-files" className="btn-primary cursor-pointer">
              📁 파일 선택
            </label>
            <span className="min-w-0 flex-1 truncate text-sm text-stone-600">{picked.length ? `${picked.length}개 선택: ${picked.join(", ")}` : "선택한 파일 없음 — 여러 개 고를 수 있습니다"}</span>
            {picked.length > 0 && (
              <button
                className="btn-ghost text-xs"
                onClick={() => {
                  if (files.current) files.current.value = "";
                  setPicked([]);
                }}
              >
                선택 취소
              </button>
            )}
          </div>
          <div className="mt-3">
            <button className="btn-accent" disabled={!!busy} onClick={() => run("analyze")}>
              {busy || "이 자료로 문체 분석"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LayoutTab({ p, reload, flash }: { p: any; reload: () => void; flash: (m: string) => void }) {
  const [l, setL] = useState<LayoutSettings>(p.layout);
  const [cpp, setCpp] = useState<number>(p.charsPerPage);
  const [err, setErr] = useState("");
  const m = l.margins;
  const cp = l.colophon;
  const setM = (k: keyof typeof m, v: number) => setL({ ...l, margins: { ...m, [k]: v } });
  const setC = (k: keyof typeof cp, v: string) => setL({ ...l, colophon: { ...cp, [k]: v } });
  const save = async () => {
    setErr("");
    try {
      await api(`/api/projects/${p.id}`, { method: "PATCH", json: { layout: l, charsPerPage: cpp } });
      await reload();
      flash("저장했습니다.");
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const num = (label: string, k: keyof typeof m, hint?: string) => (
    <div>
      <label className="label">{label}</label>
      <input type="number" step={0.5} className="input" value={m[k]} onChange={(e) => setM(k, Number(e.target.value))} />
      {hint && <p className="mt-0.5 text-[11px] text-stone-400">{hint}</p>}
    </div>
  );
  return (
    <div className="space-y-6">
      <div className="card space-y-4 p-6">
        <h2 className="font-semibold">판형 · 여백 (부크크 A5)</h2>
        <p className="text-sm text-stone-500">
          문서 154×216mm (완성 148×210mm + 재단 여백 사방 {BLEED}mm). 여백은 문서 가장자리 기준이며 기본값은 부크크 A5 한글 서식과 같습니다. 부크크 최소 안전 영역(재단선 기준 위·아래·바깥{" "}
          {SAFE_MIN_FROM_TRIM.top}mm, 안쪽 {SAFE_MIN_FROM_TRIM.inner}mm)보다 좁게는 저장되지 않습니다.
        </p>
        <div className="grid grid-cols-3 gap-4">
          {num("안쪽(제본 쪽)", "inner", "기본 28")}
          {num("바깥쪽", "outer", "기본 23")}
          {num("위", "top", "기본 18")}
          {num("아래", "bottom", "기본 18")}
          {num("머리말", "header", "기본 7")}
          {num("꼬리말(쪽 번호)", "footer", "기본 13")}
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="label">본문 글자 크기(pt)</label>
            <input type="number" step={0.5} className="input" value={l.bodySizePt} onChange={(e) => setL({ ...l, bodySizePt: Number(e.target.value) || 10 })} />
            <p className="mt-0.5 text-[11px] text-stone-400">KoPub바탕체 Light · 8~14pt</p>
          </div>
          <div>
            <label className="label">줄 간격(%)</label>
            <input type="number" step={5} min={120} max={240} className="input" value={Math.round(l.lineHeight * 100)} onChange={(e) => setL({ ...l, lineHeight: (Number(e.target.value) || 160) / 100 })} />
            <p className="mt-0.5 text-[11px] text-stone-400">기본 160%</p>
          </div>
          <div>
            <label className="label">문단 간격(mm)</label>
            <input type="number" step={0.5} min={0} max={8} className="input" value={l.paraSpacingMm} onChange={(e) => setL({ ...l, paraSpacingMm: Number(e.target.value) || 0 })} />
            <p className="mt-0.5 text-[11px] text-stone-400">문단과 문단 사이 추가 간격 · 기본 0</p>
          </div>
          <div>
            <label className="label">장·절 번호 형식</label>
            <select className="input" value={l.numberFormat} onChange={(e) => setL({ ...l, numberFormat: e.target.value as any })}>
              <option value="basic">1장 / 1.1</option>
              <option value="formal">제1장 / 01</option>
            </select>
          </div>
          <div>
            <label className="label">1쪽당 글자 수(자동 보정)</label>
            <input type="number" className="input" value={cpp} onChange={(e) => setCpp(Number(e.target.value))} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={l.chapterStartRight} onChange={(e) => setL({ ...l, chapterStartRight: e.target.checked })} />새 장은 오른쪽(홀수) 페이지에서 시작 — 필요하면 빈 쪽 자동 삽입
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={l.grayscalePreview} onChange={(e) => setL({ ...l, grayscalePreview: e.target.checked })} />
          흑백 인쇄 미리보기 (이미지 흑백 표시)
        </label>
      </div>

      <div className="card space-y-4 p-6">
        <h2 className="font-semibold">판권면</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">위치</label>
            <select className="input" value={cp.position} onChange={(e) => setC("position", e.target.value)}>
              <option value="end">책 맨 뒤 (왼쪽 면)</option>
              <option value="afterTitle">표제지 뒷면</option>
            </select>
          </div>
          {(
            [
              ["publishDate", "발행일", "2026년 00월 00일"],
              ["publisher", "펴낸이", ""],
              ["publisherName", "펴낸곳", ""],
              ["registration", "출판사등록", ""],
              ["address", "주소", ""],
              ["phone", "전화", ""],
              ["email", "이메일", ""],
              ["isbn", "ISBN", "979-11-..."],
              ["website", "웹사이트", ""],
              ["copyrightYear", "저작권 연도", ""],
            ] as const
          ).map(([k, label, ph]) => (
            <div key={k}>
              <label className="label">{label}</label>
              <input className="input" placeholder={ph} value={cp[k]} onChange={(e) => setC(k, e.target.value)} />
            </div>
          ))}
          <div className="col-span-2">
            <label className="label">저작권 문구</label>
            <input className="input" value={cp.notice} onChange={(e) => setC("notice", e.target.value)} />
          </div>
        </div>
        <p className="text-xs text-stone-500">지은이와 책 제목은 책 정보에서 가져옵니다. 기본값은 부크크 판권면 양식입니다.</p>
      </div>
      {err && <p className="whitespace-pre-wrap rounded bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
      <div className="flex justify-end">
        <button className="btn-primary" onClick={save}>
          저장
        </button>
      </div>
    </div>
  );
}

function GlossaryTab({ id }: { id: string }) {
  const [list, setList] = useState<{ id: string; term: string; preferred: string; note: string }[]>([]);
  const [f, setF] = useState({ term: "", preferred: "", note: "" });
  const load = () => api(`/api/projects/${id}/glossary`).then(setList);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return (
    <div className="card p-6">
      <p className="mb-4 text-sm text-stone-500">집필·교정·부분 수정 때 AI가 이 표기를 반드시 따릅니다. 예) 인공지능 → AI, 챗GPT → 챗GPT(ChatGPT)</p>
      <form
        className="mb-4 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api(`/api/projects/${id}/glossary`, { method: "POST", json: f });
            setF({ term: "", preferred: "", note: "" });
            load();
          } catch (er: any) {
            toastError(er);
          }
        }}
      >
        <input className="input" placeholder="용어(다양한 표기)" value={f.term} onChange={(e) => setF({ ...f, term: e.target.value })} />
        <input className="input" placeholder="통일할 표기" value={f.preferred} onChange={(e) => setF({ ...f, preferred: e.target.value })} />
        <input className="input" placeholder="메모(선택)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <button className="btn-primary shrink-0">추가</button>
      </form>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-stone-500">
          <tr>
            <th className="py-1">용어</th>
            <th>통일 표기</th>
            <th>메모</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((g) => (
            <tr key={g.id} className="border-t border-stone-100">
              <td className="py-1.5">{g.term}</td>
              <td className="font-semibold">{g.preferred}</td>
              <td className="text-stone-500">{g.note}</td>
              <td className="text-right">
                <button
                  className="btn-ghost text-xs text-red-600"
                  onClick={async () => {
                    await api(`/api/projects/${id}/glossary?gid=${g.id}`, { method: "DELETE" });
                    load();
                  }}
                >
                  삭제
                </button>
              </td>
            </tr>
          ))}
          {!list.length && (
            <tr>
              <td colSpan={4} className="py-6 text-center text-stone-400">
                용어가 없습니다
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

type Learned = { observations: string[]; avoid: string[]; prefer: string[]; signaturePhrases: string[]; sampleExcerpts: string[]; pairs: number; editRate: number | null };
type EditStats = { overall: number | null; sections: { sectionId: string; title: string; rate: number; aiChars: number }[] };

const LEARN_KEYS: [keyof Learned & string, string][] = [
  ["avoid", "앞으로 쓰지 않을 것"],
  ["prefer", "작가가 고쳐 쓰는 방식 (따를 것)"],
  ["signaturePhrases", "새로 발견한 고유 표현"],
  ["sampleExcerpts", "문체 참고 발췌로 추가"],
];

/** 작가 수정에서 배우기 — AI 초안 원본과 작가가 고친 지금 원고를 비교해 문체 프로필에 더할 규칙을 제안 */
function EditLearnCard({ p, reload, flash }: { p: any; reload: () => void; flash: (m: string) => void }) {
  const [stats, setStats] = useState<EditStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [learned, setLearned] = useState<Learned | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    api<EditStats>(`/api/projects/${p.id}/edit-stats`).then(setStats).catch(() => {});
  }, [p.id]);

  const learn = async () => {
    setBusy(true);
    try {
      const r = await api<Learned>(`/api/projects/${p.id}/style/learn`, { method: "POST" });
      setLearned(r);
      setPicked(new Set(LEARN_KEYS.flatMap(([k]) => (r[k] as string[]).map((_, i) => `${k}:${i}`))));
    } catch (e: any) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!learned) return;
    const cur = p.styleProfile ? JSON.parse(p.styleProfile) : {};
    const next = { ...cur };
    for (const [k] of LEARN_KEYS) {
      const add = (learned[k] as string[]).filter((_, i) => picked.has(`${k}:${i}`));
      if (!add.length) continue;
      const base: string[] = Array.isArray(cur[k]) ? cur[k] : [];
      const merged = [...base, ...add.filter((x) => !base.includes(x))];
      // 발췌는 프롬프트에 앞 3개만 들어가므로 새 것을 앞에 둔다
      next[k] = k === "sampleExcerpts" ? [...add, ...base.filter((x) => !add.includes(x))].slice(0, 6) : merged.slice(-20);
    }
    await api(`/api/projects/${p.id}`, { method: "PATCH", json: { styleProfile: next } });
    setLearned(null);
    await reload();
    flash("문체 프로필에 반영했습니다. 다음 집필부터 적용됩니다.");
  };

  const top = stats?.sections.filter((s) => s.rate > 0).sort((a, b) => b.rate - a.rate).slice(0, 5) ?? [];
  return (
    <div className="card space-y-3 p-6">
      <h2 className="font-semibold">작가 수정에서 배우기</h2>
      <p className="text-xs leading-5 text-stone-500">
        AI가 쓴 초안 원본과 작가가 직접 고친 지금 원고를 문장 단위로 비교합니다. 자주 고치는 표현을 찾아 문체 프로필에 더하면 다음 초안부터 덜 고쳐도 됩니다.
      </p>
      {stats && (
        <div className="rounded-lg bg-stone-50 p-3 text-sm">
          {stats.overall === null ? (
            <span className="text-stone-500">아직 비교할 AI 초안이 없습니다. (이 기능 이후 AI로 집필한 절부터 기록됩니다)</span>
          ) : (
            <>
              <div>
                작가 수정률 <b className="text-lg">{stats.overall}%</b>
                <span className="ml-2 text-xs text-stone-500">AI 초안 {stats.sections.length}개 절 기준 · 낮을수록 AI가 작가처럼 쓰고 있다는 뜻</span>
              </div>
              {top.length > 0 && (
                <ul className="mt-1 text-xs text-stone-600">
                  {top.map((s) => (
                    <li key={s.sectionId}>
                      {s.title} — {s.rate}%
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
      <button className="btn-accent" disabled={busy || !stats?.overall} onClick={learn}>
        {busy ? "수정 패턴 분석 중… (1분 안팎)" : "수정 패턴 분석하기"}
      </button>
      {learned && (
        <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50/40 p-4 text-sm">
          <div className="text-xs text-stone-500">수정한 문장 {learned.pairs}쌍을 분석했습니다. 반영할 항목을 고르세요.</div>
          {learned.observations.length > 0 && (
            <ul className="list-disc pl-5 text-xs leading-5 text-stone-700">
              {learned.observations.map((o, i) => (
                <li key={i}>{o}</li>
              ))}
            </ul>
          )}
          {LEARN_KEYS.map(([k, label]) =>
            (learned[k] as string[]).length ? (
              <div key={k}>
                <div className="mb-1 text-xs font-semibold text-stone-600">{label}</div>
                {(learned[k] as string[]).map((x, i) => (
                  <label key={i} className="flex items-start gap-2 py-0.5 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={picked.has(`${k}:${i}`)}
                      onChange={(e) => {
                        const n = new Set(picked);
                        if (e.target.checked) n.add(`${k}:${i}`);
                        else n.delete(`${k}:${i}`);
                        setPicked(n);
                      }}
                    />
                    <span className={k === "sampleExcerpts" ? "font-book text-[13px]" : ""}>{x}</span>
                  </label>
                ))}
              </div>
            ) : null,
          )}
          <div className="flex gap-2">
            <button className="btn-primary" disabled={!picked.size} onClick={apply}>
              고른 {picked.size}개를 프로필에 반영
            </button>
            <button className="btn" onClick={() => setLearned(null)}>
              버리기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
